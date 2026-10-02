import { DESIGN_IDS, PAGE_IDS, PAGES, SiteDocument, type DesignId, type PageId } from "@asksite/site-schema";
import { formatterFactory, HtmlValidate, StaticConfigLoader } from "html-validate";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIXTURES, loadFixture, renderFixture, renderFixturePage, stubStylesheets, type FixtureName } from "../../../fixtures/index.ts";
import { escapeText } from "../src/escape.ts";
import { loadCompiledCss, missingClasses } from "./support/css-classes.ts";
import { startTags } from "./support/page-safety.ts";
import { countInText, squash, squashedText } from "./support/page-text.ts";

// Golden files hold markup only; the real stylesheet would add ~30 KB of noise to every diff.
const STUB_CSS = stubStylesheets("/* site.css */");

// A missing or changed golden fails the run; only UPDATE_GOLDENS=1 writes them (A9). Vitest's own
// file snapshots would be rewritten by any local run that finds one missing, and by -u. One golden per
// design, fixture and page: fixtures/golden/<design>/<fixture>/<page>.html (A12, A16).
const UPDATE_GOLDENS = process.env["UPDATE_GOLDENS"] === "1";
const GOLDEN_DIR = fileURLToPath(new URL("../../../fixtures/golden/", import.meta.url));
const goldenPath = (design: DesignId, name: string, page: PageId) => `${GOLDEN_DIR}${design}/${name}/${page}.html`;

// html-validate's recommended rules. tel-non-breaking is satisfied with CSS instead of
// &nbsp;/&#8209; entities: every tel: link carries whitespace-nowrap, so it cannot wrap.
const htmlValidate = new HtmlValidate(
  new StaticConfigLoader({
    extends: ["html-validate:recommended"],
    rules: { "tel-non-breaking": ["error", { ignoreClasses: ["whitespace-nowrap"] }] },
  }),
);

const sectionIds = (html: string) => [...html.matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1]);

describe.each(FIXTURES)("fixture %s", (name) => {
  it("is a valid SiteDocument", () => {
    expect(SiteDocument.safeParse(loadFixture(name)).success).toBe(true);
  });
});

// The pages each fixture's content gives it (A16; read from the fixture's JSON: photos, an about text, the FAQ).
const EXPECTED_PAGES: Record<FixtureName, readonly PageId[]> = {
  "plumber-austin": ["home", "services", "about", "gallery", "contact"],
  "hvac-phoenix": ["home", "services", "gallery", "contact"], // no about text
  "roofing-extreme": ["home", "services", "about", "gallery", "contact"],
  "cleaning-minimal": ["home", "services", "contact"], // no photos, no about text
  "electrical-xss": ["home", "services", "about", "gallery", "contact"],
};

// Every page of every fixture in every design (A12, A16).
describe.each(DESIGN_IDS)("the %s design", (design) => {
  describe.each(FIXTURES)("with fixture %s", (name) => {
    const pages = renderFixture(name, STUB_CSS, design);

    it("has the pages its content gives it, Home first", () => {
      expect(pages.map((p) => p.page)).toEqual(EXPECTED_PAGES[name]);
    });

    it.each(pages)("matches its golden HTML: the $page page", ({ page, html }) => {
      const golden = goldenPath(design, name, page);
      if (UPDATE_GOLDENS) {
        mkdirSync(dirname(golden), { recursive: true });
        writeFileSync(golden, html);
      }
      expect(existsSync(golden), `${golden} is missing: review the page, then run the tests with UPDATE_GOLDENS=1`).toBe(true);
      expect(html).toBe(readFileSync(golden, "utf8"));
    });

    it.each(pages)("passes html-validate (recommended): the $page page", async ({ html }) => {
      const report = await htmlValidate.validateString(html);
      if (!report.valid) console.log(formatterFactory("text")(report.results));
      expect(report.valid).toBe(true);
    });

    it.each(pages)("uses only classes that exist in the design's compiled stylesheet: the $page page", ({ html }) => {
      expect(missingClasses(html, loadCompiledCss(design))).toEqual([]);
    });
  });

  // No golden is left behind for a page a fixture no longer has, or for a fixture that is gone (a modify/delete conflict).
  it("holds exactly the goldens of its pages and no other file", () => {
    const expected = FIXTURES.flatMap((name) => renderFixture(name, STUB_CSS, design).map((p) => `${name}/${p.page}.html`)).sort();
    const found = readdirSync(`${GOLDEN_DIR}${design}`, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `${entry.parentPath.slice(`${GOLDEN_DIR}${design}`.length + 1)}/${entry.name}`.replace(/^\//, ""))
      .sort();
    expect(found).toEqual(expected);
  });
});

it("holds a golden folder for every design and no other", () => {
  expect(readdirSync(GOLDEN_DIR).sort()).toEqual([...DESIGN_IDS].sort());
});

describe("html-validate catches broken markup (RED proof)", () => {
  it("rejects a mis-nested page", async () => {
    const report = await htmlValidate.validateString(
      "<!DOCTYPE html><html lang=\"en\"><head><title>x</title></head><body><div><p>x</span></body></html>",
    );
    expect(report.valid).toBe(false);
  });
});

// Content checks count meaning, not class strings, so they hold for every design (A12 §8, A16); each design's
// goldens pin its exact markup.
const sectionOf = (html: string, id: string) => {
  const start = html.indexOf(`<section id="${id}"`);
  return start === -1 ? "" : html.slice(start, html.indexOf("</section>", start));
};
const textIn = (markup: string) => markup.split(/<[^>]*>/).map((text) => text.trim()).filter(Boolean);
const tagsWith = (markup: string, name: string, attribute: string, value: string) =>
  startTags(markup).filter((t) => t.name === name && t.attributes.some((a) => a.name === attribute && a.value === value));
const h1Text = (html: string) => squashedText(html.slice(html.indexOf("<h1"), html.indexOf("</h1>")));
const titleText = (html: string) => /<title>([^<]*)<\/title>/.exec(html)?.[1];

describe.each(DESIGN_IDS)("content resilience in the %s design", (design) => {
  const page = (name: FixtureName, id: PageId) => renderFixturePage(name, id, STUB_CSS, design);

  it("minimal: three pages, each hiding every section that has no owner content", () => {
    const pages = renderFixture("cleaning-minimal", STUB_CSS, design);
    expect(pages.map((p) => [p.page, sectionIds(p.html)])).toEqual([
      ["home", ["top", "services-preview", "get-in-touch"]],
      ["services", ["services", "get-in-touch"]],
      ["contact", ["contact", "service-area"]],
    ]);
    const all = pages.map((p) => p.html).join("");
    expect(all).not.toContain("<img");
    expect(all).not.toContain("FAQPage");
    expect(all).not.toContain("Credentials");
  });

  it("extreme: Home draws the hero, the services preview, the reviews (before the trust strip, the owner's order) and the closing band", () => {
    const html = page("roofing-extreme", "home");
    expect(sectionIds(html)).toEqual(["top", "services-preview", "reviews", "credentials", "get-in-touch"]);
    expect(countInText(html, "From $100,000")).toBe(3); // the preview's first three services
    expect(h1Text(html)).toBe(squash(escapeText(loadFixture("roofing-extreme").copy.heroHeadline)));
    expect(titleText(html)).toBe("Longhorn Storm Restoration Roofing, Gutters, Siding &amp; Window");
  });

  it("extreme: Services renders every service and FAQ item at maximum length and count", () => {
    const html = page("roofing-extreme", "services");
    expect(sectionIds(html)).toEqual(["services", "faq", "get-in-touch"]);
    expect(countInText(html, "From $100,000")).toBe(12);
    expect(tagsWith(html, "details", "name", "faq")).toHaveLength(8);
    expect(h1Text(html)).toBe(squash("Our services"));
    expect(titleText(html)).toBe("Services | Longhorn Storm Restoration Roofing, Gutters, Siding &amp;…");
  });

  it("extreme: Gallery shows all 12 photos, lazy-loaded", () => {
    const html = page("roofing-extreme", "gallery");
    expect(sectionIds(html)).toEqual(["our-work", "get-in-touch"]);
    expect(tagsWith(sectionOf(html, "our-work"), "img", "loading", "lazy")).toHaveLength(12);
    expect(h1Text(html)).toBe(squash("Our work"));
  });

  it("extreme: Contact leads with the service area (the owner's order) and lists all 30 places", () => {
    const html = page("roofing-extreme", "contact");
    const { facts, copy } = loadFixture("roofing-extreme");
    expect(sectionIds(html)).toEqual(["service-area", "contact"]);
    const places = textIn(sectionOf(html, "service-area"));
    expect(facts.serviceArea.places).toHaveLength(30);
    expect(facts.serviceArea.places.filter((place) => !places.includes(escapeText(place)))).toEqual([]);
    expect(html).toContain('<form id="quote" ');
    expect(h1Text(html)).toBe(squash("Service area & hours".replace("&", "&amp;")));
    expect(squashedText(sectionOf(html, "contact"))).toContain(squash(escapeText(copy.ctaText)));
  });

  it("extreme: About shows the name in the h1", () => {
    expect(h1Text(page("roofing-extreme", "about"))).toBe(squash(`About ${escapeText(loadFixture("roofing-extreme").facts.businessName)}`));
  });

  it.each(FIXTURES)("%s: every page has one h1 and a title of its own, from the page map's labels", (name) => {
    const { facts, copy } = loadFixture(name);
    const wanted: Record<PageId, string> = {
      home: escapeText(copy.heroHeadline),
      services: "Our services",
      about: `About ${escapeText(facts.businessName)}`,
      gallery: "Our work",
      contact: escapeText(copy.ctaText),
    };
    const pages = renderFixture(name, STUB_CSS, design);
    expect(pages.map((p) => [p.page, p.html.match(/<h1\b/g)?.length, h1Text(p.html)])).toEqual(pages.map((p) => [p.page, 1, squash(p.page === "contact" && name === "roofing-extreme" ? "Service area &amp; hours" : wanted[p.page])]));
    const titles = pages.map((p) => titleText(p.html) ?? "");
    expect(new Set(titles).size).toBe(pages.length);
    expect(titles.slice(1).map((t, i) => t.startsWith(`${PAGES[pages[i + 1]!.page].label} | `))).toEqual(titles.slice(1).map(() => true));
  });
});
