import { DESIGN_IDS, PAGE_IDS, PAGES, SiteDocument, type DesignId, type PageId, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { FIXTURE_SITE_URL, inDesign, stubStylesheets } from "../../../fixtures/index.ts";
import { DESIGNS } from "../src/designs/index.ts";
import { pageTitle, render, type RenderOptions } from "../src/index.ts";
import { FULL, MINIMAL } from "./support/doc.ts";
import { squash, squashedText } from "./support/page-text.ts";

const OPTIONS: RenderOptions = { stylesheets: stubStylesheets("/* compiled css */"), formAction: "https://forms.example.com/submit", siteUrl: FIXTURE_SITE_URL };
const renderHtml = (input: SiteDocumentInput, options: RenderOptions = OPTIONS) => render(input, options).pages[0]!.html;
const pageHtml = (input: SiteDocumentInput, page: PageId) => render(input, OPTIONS).pages.find((p) => p.page === page)!.html;
const scriptTags = (html: string) => [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);

describe("render", () => {
  const page = renderHtml(FULL);

  it("returns one complete HTML document", () => {
    expect(page.startsWith("<!DOCTYPE html>\n<html lang=\"en\"")).toBe(true);
    expect(page.trimEnd().endsWith("</html>")).toBe(true);
    expect(page.match(/<h1/g)).toHaveLength(1);
    expect(page).toContain("<title>Reliable Rooter | Plumbing in Austin, TX</title>");
    expect(page).toContain('<meta name="description" content="Leaks, clogs and water heaters fixed right the first time.">');
  });

  it("inlines the design's stylesheet, the 12 theme variables and the design's own variables", () => {
    expect(page).toContain("<style>/* compiled css */</style>");
    const parsed = SiteDocument.parse(FULL);
    expect(page.match(/--aw-[a-z0-9-]+:/g)).toHaveLength(12 + Object.keys(DESIGNS[parsed.theme.design].variables(parsed.theme)).length);
    expect(page.match(/<style>:root\{/g)).toHaveLength(1);
  });

  it("ships zero JavaScript on every page: the only scripts are JSON-LD", () => {
    for (const { html: text } of render(FULL, OPTIONS).pages) {
      expect(scriptTags(text).every((tag) => tag === '<script type="application/ld+json">')).toBe(true);
      expect(text).not.toMatch(/\son[a-z]+=/i);
      expect(text).not.toMatch(/javascript:/i);
      expect(text).not.toMatch(/http-equiv/i);
    }
    expect(scriptTags(page)).toHaveLength(1);
  });

  it("carries the MIT copyright notices in one comment on every page, the design's attribution", () => {
    for (const { html: text } of render(FULL, OPTIONS).pages) {
      expect(text.match(/<!--/g)).toHaveLength(1);
      expect(text).toContain(DESIGNS.impact.attribution);
    }
  });

  it("emits FAQPage JSON-LD only on the Services page, and only when the FAQ section renders", () => {
    expect(pageHtml(FULL, "services")).toContain('"@type":"FAQPage"');
    expect(page).not.toContain("FAQPage");
    const minimal = render(MINIMAL, OPTIONS);
    expect(minimal.pages.map((p) => p.html).join("")).not.toContain("FAQPage");
    expect(scriptTags(pageHtml(MINIMAL, "services"))).toHaveLength(0);
    expect(scriptTags(minimal.pages[0]!.html)).toHaveLength(1);
  });

  const sectionIds = (text: string) => [...text.matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1]);

  it("renders each page's sections in layout order, hiding empty ones, with the services preview and the closing band", () => {
    expect(PAGE_IDS.map((p) => [p, sectionIds(pageHtml(FULL, p))])).toEqual([
      ["home", ["top", "credentials", "services-preview", "reviews", "get-in-touch"]],
      ["services", ["services", "faq", "get-in-touch"]],
      ["about", ["about", "get-in-touch"]],
      ["gallery", ["our-work", "get-in-touch"]],
      ["contact", ["contact", "service-area"]],
    ]);
    const minimal = render(MINIMAL, OPTIONS).pages;
    expect(minimal.map((p) => [p.page, sectionIds(p.html)])).toEqual([
      ["home", ["top", "services-preview", "get-in-touch"]],
      ["services", ["services", "get-in-touch"]],
      ["contact", ["contact", "service-area"]],
    ]);
  });

  it("puts the services preview after Home's last section when Home has no testimonials", () => {
    const { testimonials: _t, ...facts } = FULL.facts;
    expect(sectionIds(pageHtml({ ...FULL, facts }, "home"))).toEqual(["top", "credentials", "services-preview", "get-in-touch"]);
  });

  it("follows the owner's order within a page (U1), the preview still right before testimonials", () => {
    const pick = (id: string) => FULL.layout.filter((s) => s.id === id);
    const layout = [...pick("hero"), ...pick("testimonials"), ...pick("trust"), ...FULL.layout.filter((s) => !["hero", "testimonials", "trust"].includes(s.id))];
    expect(sectionIds(pageHtml({ ...FULL, layout }, "home"))).toEqual(["top", "services-preview", "reviews", "credentials", "get-in-touch"]);
  });

  it("is deterministic", () => {
    expect(renderHtml(FULL)).toBe(page);
  });

  it("re-validates input and refuses bad options", () => {
    expect(() => renderHtml({ ...FULL, copy: { ...FULL.copy, heroHeadline: "Call 512-555-0142" } })).toThrow();
    expect(() => renderHtml(FULL, { ...OPTIONS, formAction: "http://forms.example.com" })).toThrow("Unsafe URL");
    expect(() => renderHtml(FULL, { ...OPTIONS, stylesheets: stubStylesheets("</style><script>alert(1)</script>") })).toThrow("</style");
  });

  it("returns the site: its design, its sheet's hash and every page in the page map's order, Home first", () => {
    const site = render(FULL, OPTIONS);
    const parsed = SiteDocument.parse(FULL);
    expect(site.design).toBe(parsed.theme.design);
    expect(site.stylesheetSha256).toBe(OPTIONS.stylesheets[parsed.theme.design].sha256);
    expect(site.pages.map(({ page, path }) => ({ page, path }))).toEqual(PAGE_IDS.map((id) => ({ page: id, path: PAGES[id].path })));
    expect(site.pages[0]?.html).toBe(page);
  });

  it.each([
    ["a path", "https://fixture.asksite.example/shop/"],
    ["a query", "https://fixture.asksite.example/?a=1"],
    ["a hash", "https://fixture.asksite.example/#top"],
    ["userinfo", "https://user@fixture.asksite.example/"],
    ["http", "http://fixture.asksite.example/"],
    ["no final slash", "https://fixture.asksite.example"],
    ["a different spelling of the origin", "https://FIXTURE.asksite.example/"],
    ["a default port", "https://fixture.asksite.example:443/"],
    ["not a URL", "fixture.asksite.example"],
    ["empty", ""],
  ])("refuses a siteUrl with %s", (_name, siteUrl) => {
    expect(() => renderHtml(FULL, { ...OPTIONS, siteUrl })).toThrow();
  });

  it("accepts an https origin with a port and a final slash", () => {
    expect(() => renderHtml(FULL, { ...OPTIONS, siteUrl: "https://joes.asksite.example:8443/" })).not.toThrow();
  });

  it("falls back to the business name when the title would be too long", () => {
    const long = SiteDocument.parse({ ...FULL, facts: { ...FULL.facts, businessName: "B".repeat(60) } });
    expect(pageTitle(long)).toBe("B".repeat(60));
  });
});

describe("facts and copy stay separate", () => {
  const page = renderHtml(FULL);

  it("takes phone, prices, licences, hours and reviews only from facts", () => {
    const changed: SiteDocumentInput = {
      ...FULL,
      facts: {
        ...FULL.facts,
        phone: "+12125550100",
        services: [{ name: "Drain cleaning", startingPrice: 95 }, { name: "Water heaters" }, { name: "Leak repair" }],
        licences: [{ label: "NYC master plumber", number: "MP-7" }],
        hours: [{ days: ["Monday"], opens: "07:00", closes: "15:00" }],
        testimonials: [{ quote: "Changed quote.", name: "Pat" }],
      },
    };
    const out = render(changed, OPTIONS).pages.map((p) => p.html).join("\n");
    // The new facts are read as page text (any design's markup); the old ones must be gone from the markup.
    const text = squashedText(out);
    expect(squashedText(page)).toContain(squash("(512) 555-0142"));
    expect(out).not.toContain("(512) 555-0142");
    expect(text).toContain(squash("(212) 555-0100"));
    expect(text).toContain(squash("From $95"));
    expect(out).not.toContain("$89");
    expect(text).toContain(squash("NYC master plumber: MP-7"));
    expect(text).toContain(squash("7:00 AM – 3:00 PM"));
    expect(text).toContain(squash("Changed quote."));
    expect(out).not.toContain("Fixed our burst pipe");
  });

  it("renders the same facts no matter what the copy says", () => {
    const otherCopy = renderHtml({ ...FULL, copy: { ...FULL.copy, heroHeadline: "Different words entirely" } });
    const facts = (html: string) => [...html.matchAll(/tel:\+\d+/g), ...squashedText(html).matchAll(/From\$[\d,]+|M-40123/g)].map((m) => m[0]);
    expect(facts(page)).toEqual(expect.arrayContaining(["tel:+15125550142", "From$89", "M-40123"]));
    expect(facts(otherCopy)).toEqual(facts(page));
  });
});

describe("page designs (A12)", () => {
  it("renders a stored document without a design in the default design, impact", () => {
    const page = render(FULL, OPTIONS);
    expect(page.design).toBe("impact");
    expect(page.pages[0]!.html).toContain('<body data-design="impact" class="');
  });

  it.each(DESIGN_IDS)("%s: names the parsed document's design on <body> and in the result", (design) => {
    const page = render(inDesign(FULL, design), OPTIONS);
    expect(page.design).toBe(design);
    expect(page.pages[0]!.html.match(/<body\b[^>]*>/g)).toEqual([`<body data-design="${design}" class="${DESIGNS[design].bodyClass}">`]);
  });

  it.each(DESIGN_IDS)("%s: inlines its own stylesheet, never another design's, and returns that sheet's SHA-256", (design) => {
    const stylesheets = stubStylesheets((id) => `/* the ${id} sheet */`);
    const page = render(inDesign(FULL, design), { ...OPTIONS, stylesheets });
    for (const id of DESIGN_IDS) expect(page.pages[0]!.html.includes(`<style>/* the ${id} sheet */</style>`)).toBe(id === design);
    expect(page.stylesheetSha256).toBe(stylesheets[design].sha256);
    expect(new Set(DESIGN_IDS.map((id) => stylesheets[id].sha256)).size).toBe(DESIGN_IDS.length); // the stubs differ
  });

  it("refuses stylesheets that have no sheet for the page's design", () => {
    const { refined: _refined, ...others } = stubStylesheets();
    expect(() => render(inDesign(FULL, "refined"), { ...OPTIONS, stylesheets: others as never })).toThrow('No stylesheet for the "refined" design');
    expect(render(inDesign(FULL, "modern"), { ...OPTIONS, stylesheets: others as never }).design).toBe("modern");
  });

  it("refuses a design the schema does not list", () => {
    expect(() => render(inDesign(FULL, "brutalist" as DesignId), OPTIONS)).toThrow('"design"');
  });
});
