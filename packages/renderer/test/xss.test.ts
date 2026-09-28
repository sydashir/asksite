import { describe, expect, it } from "vitest";
import { loadFixture, renderFixture, stubStylesheets } from "../../../fixtures/index.ts";
import { render } from "../src/index.ts";
import { FULL } from "./support/doc.ts";

// Every free-text field of this fixture holds an XSS payload (script tags, event handlers,
// attribute breakouts, javascript: URLs, </script> and </style> breakouts).
const page = renderFixture("electrical-xss", stubStylesheets());

const ALLOWED_TAGS = new Set(
  (
    "html head meta title style script body a header div nav ul li details summary span svg path g main section " +
    "p h1 h2 h3 img figure figcaption blockquote hr table tbody tr th td address br form label input select option " +
    "textarea button aside footer"
  ).split(" "),
);

// Attributes the browser fetches or navigates to.
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster", "cite", "data", "ping", "background", "xlink:href", "srcset"]);

// Start tags and attributes as the HTML tokenizer reads them: attribute values may be
// double-quoted, single-quoted or unquoted. Our templates only write double quotes, so any
// other form can only come from a payload that escaped escaping.
const ATTRIBUTE_SOURCE = String.raw`\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\x60]+))?`;
const START_TAG = new RegExp(String.raw`<([a-zA-Z][\w-]*)((?:${ATTRIBUTE_SOURCE})*)\s*\/?>`, "g");
const ATTRIBUTE = /\s+([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const startTags = [...page.matchAll(START_TAG)].map((m) => ({
  name: (m[1] ?? "").toLowerCase(),
  attributes: [...(m[2] ?? "").matchAll(ATTRIBUTE)].map((a) => ({
    name: (a[1] ?? "").toLowerCase(),
    value: a[2] ?? a[3] ?? a[4] ?? "",
  })),
  raw: m[0],
}));

describe("XSS payloads are neutralised", () => {
  it("every raw '<' in the page starts one of our own tags or our one comment", () => {
    const endTags = page.match(/<\/[a-zA-Z][\w-]*>/g) ?? [];
    const doctype = page.match(/<!DOCTYPE html>/g) ?? [];
    const comments = page.match(/<!--/g) ?? [];
    expect(comments).toHaveLength(1);
    expect((page.match(/</g) ?? []).length).toBe(startTags.length + endTags.length + doctype.length + comments.length);
  });

  it("creates no unexpected elements", () => {
    expect(startTags.map((t) => t.name).filter((n) => !ALLOWED_TAGS.has(n))).toEqual([]);
  });

  it("creates no event-handler attributes, quoted or not", () => {
    const names = startTags.flatMap((t) => t.attributes.map((a) => a.name));
    expect(names.length).toBeGreaterThan(100);
    expect(names.filter((n) => n.startsWith("on"))).toEqual([]);
  });

  it("has only the two JSON-LD scripts and the two style blocks we emit", () => {
    expect(startTags.filter((t) => t.name === "script").map((t) => t.raw)).toEqual([
      '<script type="application/ld+json">',
      '<script type="application/ld+json">',
    ]);
    expect(startTags.filter((t) => t.name === "style")).toHaveLength(2);
  });

  it("never renders a script URL in any attribute", () => {
    const attributes = startTags.flatMap((t) => t.attributes);
    const urls = attributes.filter((a) => URL_ATTRIBUTES.has(a.name)).map((a) => a.value);
    expect(urls.length).toBeGreaterThan(10);
    for (const url of urls) expect(url).toMatch(/^(https:|tel:|mailto:|#)/);
    expect(attributes.filter((a) => /^\s*(javascript|vbscript|data):/i.test(a.value))).toEqual([]);
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

  it("refuses a theme payload at the render boundary", () => {
    const options = { stylesheets: stubStylesheets(""), formAction: "https://forms.example.com/submit" };
    const payload = "red;}</style><script>alert(1)</script>";
    expect(() => render({ ...FULL, theme: { palette: payload, font: "clean" } } as never, options)).toThrow('"palette"');
    expect(() => render({ ...FULL, theme: { palette: "navy-orange", font: payload } } as never, options)).toThrow('"font"');
  });
});
