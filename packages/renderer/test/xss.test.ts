import { DESIGN_IDS } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { FIXTURES, loadFixture, renderFixture, stubStylesheets } from "../../../fixtures/index.ts";
import { render } from "../src/index.ts";
import { FULL } from "./support/doc.ts";
import { pageSafetyProblems, startTags } from "./support/page-safety.ts";

const STUB = stubStylesheets();

// Every fixture in every design (A12).
describe.each(DESIGN_IDS)("the %s design", (design) => {
  it.each(FIXTURES)("renders %s with nothing that runs script or loads what it should not", (name) => {
    expect(pageSafetyProblems(renderFixture(name, STUB, design))).toEqual([]);
  });

  // Every free-text field of this fixture holds an XSS payload (script tags, event handlers,
  // attribute breakouts, javascript: URLs, </script> and </style> breakouts), in all nine sections.
  describe("with the electrical-xss payloads", () => {
    const page = renderFixture("electrical-xss", STUB, design);
    const attributes = startTags(page).flatMap((t) => t.attributes);

    it("is a page worth checking: many attributes and links", () => {
      expect(attributes.length).toBeGreaterThan(100);
      expect(attributes.filter((a) => ["href", "src", "action"].includes(a.name)).length).toBeGreaterThan(10);
      expect(startTags(page).filter((t) => t.name === "script")).toHaveLength(2);
    });

    it("shows payloads as text", () => {
      expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
      expect(page).toContain('alt="&quot; onerror=&quot;alert(1)"');
      expect(page).toContain("&lt;script&gt;alert(document.domain)&lt;/script&gt;</h1>");
    });

    it("keeps JSON-LD intact: payloads round-trip without breaking out", () => {
      const blocks = [...page.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)].map((m) =>
        JSON.parse(m[1] ?? "null"),
      );
      const doc = loadFixture("electrical-xss");
      expect(blocks[0].name).toBe(doc.facts.businessName);
      expect(blocks[1].mainEntity[0].acceptedAnswer.text).toBe(doc.copy.faq?.[0]?.answer);
    });
  });
});

describe("the page checks can fail (RED proof)", () => {
  const page = renderFixture("plumber-austin", STUB);
  const inject = (markup: string) => page.replace('<main id="main">', `<main id="main">${markup}`);

  it("pass the real page", () => {
    expect(pageSafetyProblems(page)).toEqual([]);
  });

  it.each([
    ["<img src=x onerror=alert(1)>", ["unquoted src", "url src=x", "handler onerror", "unquoted onerror"]],
    ['<a href="javascript:alert(1)">x</a>', ["url href=javascript:alert(1)", "scheme href=javascript:alert(1)"]],
    ['<iframe src="https://evil.example/"></iframe>', ["element iframe"]],
    ["<script>alert(1)</script>", ["script <script>", "3 scripts"]],
    ['<div style="background:url(https://evil.example/)">x</div>', ["attribute style"]],
    ["<style>p{}</style>", ["3 style blocks"]],
    ["<!-- x -->", ["2 comments"]],
    ["1 < 2", ['a raw "<" that starts none of our tags']],
  ])("catch %s", (markup, problems) => {
    expect(pageSafetyProblems(inject(markup))).toEqual(problems);
  });
});

describe("the render boundary", () => {
  it("refuses a theme payload", () => {
    const options = { stylesheets: stubStylesheets(""), formAction: "https://forms.example.com/submit" };
    const payload = "red;}</style><script>alert(1)</script>";
    expect(() => render({ ...FULL, theme: { palette: payload, font: "clean" } } as never, options)).toThrow('"palette"');
    expect(() => render({ ...FULL, theme: { palette: "navy-orange", font: payload } } as never, options)).toThrow('"font"');
    expect(() => render({ ...FULL, theme: { palette: "navy-orange", font: "clean", design: payload } } as never, options)).toThrow('"design"');
  });
});
