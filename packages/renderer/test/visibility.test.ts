import { HIDEABLE_SECTIONS, SiteDocument, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { loadFixture } from "../../../fixtures/index.ts";
import { sitePages, visibleSections } from "../src/visibility.ts";
import { FULL, MINIMAL } from "./support/doc.ts";

describe("visibleSections", () => {
  it("keeps every section that has content, in layout order", () => {
    expect(visibleSections(SiteDocument.parse(FULL)).map((s) => s.id)).toEqual([
      "hero",
      "trust",
      "testimonials",
      "services",
      "faq",
      "about",
      "gallery",
      "contact",
      "serviceArea",
    ]);
  });

  it("hides sections whose optional facts or copy are missing", () => {
    expect(visibleSections(SiteDocument.parse(MINIMAL)).map((s) => s.id)).toEqual([
      "hero",
      "services",
      "contact",
      "serviceArea",
    ]);
  });

  it("shows the trust strip for any single credential", () => {
    const withInsured = { ...MINIMAL, facts: { ...MINIMAL.facts, insured: true } };
    expect(visibleSections(SiteDocument.parse(withInsured)).map((s) => s.id)).toContain("trust");
  });
});

// A16: the pages of a site. Counts are checked against each fixture's JSON.
describe("sitePages (A16)", () => {
  const pagesOf = (input: SiteDocumentInput) => sitePages(SiteDocument.parse(input)).map((p) => [p.id, p.sections.map((s) => s.id)]);

  it.each([
    ["plumber-austin", ["home", "services", "about", "gallery", "contact"]],
    ["hvac-phoenix", ["home", "services", "gallery", "contact"]], // no about text
    ["roofing-extreme", ["home", "services", "about", "gallery", "contact"]],
    ["cleaning-minimal", ["home", "services", "contact"]], // no photos, no about text
    ["electrical-xss", ["home", "services", "about", "gallery", "contact"]],
  ] as const)("%s has the pages its content gives it, in the page map's order", (name, expected) => {
    expect(sitePages(SiteDocument.parse(loadFixture(name))).map((p) => p.id)).toEqual(expected);
  });

  it("gives each page its path and label from the page map, and only its own sections", () => {
    const pages = sitePages(SiteDocument.parse(FULL));
    expect(pages.map((p) => [p.id, p.path, p.label])).toEqual([
      ["home", "/", "Home"],
      ["services", "/services", "Services"],
      ["about", "/about", "About"],
      ["gallery", "/gallery", "Gallery"],
      ["contact", "/contact", "Contact"],
    ]);
    expect(pages.map((p) => p.sections.map((s) => s.id))).toEqual([["hero", "trust", "testimonials"], ["services", "faq"], ["about"], ["gallery"], ["contact", "serviceArea"]]);
  });

  it("has a page if and only if one of its sections is visible: hiding About or Gallery removes the page", () => {
    expect(pagesOf({ ...FULL, hidden: ["about"] }).map(([id]) => id)).toEqual(["home", "services", "gallery", "contact"]);
    expect(pagesOf({ ...FULL, hidden: ["gallery", "about"] }).map(([id]) => id)).toEqual(["home", "services", "contact"]);
    expect(pagesOf({ ...FULL, hidden: ["trust", "testimonials"] })[0]).toEqual(["home", ["hero"]]);
    expect(pagesOf({ ...FULL, hidden: ["faq"] })[1]).toEqual(["services", ["services"]]);
    expect(pagesOf({ ...FULL, hidden: ["serviceArea"] }).at(-1)).toEqual(["contact", ["contact"]]);
    expect(pagesOf(MINIMAL).map(([id]) => id)).toEqual(["home", "services", "contact"]);
  });

  it("always has Home, Services and Contact, whatever the owner hides", () => {
    expect(pagesOf({ ...FULL, hidden: [...HIDEABLE_SECTIONS] }).map(([id]) => id)).toEqual(["home", "services", "contact"]);
  });

  // U1 (user 2026-10-01): the owner's order inside a page is followed, and a section never leaves its page.
  it("follows the layout's order within a page (U1)", () => {
    const roofing = sitePages(SiteDocument.parse(loadFixture("roofing-extreme")));
    expect(roofing[0]?.sections.map((s) => s.id)).toEqual(["hero", "testimonials", "trust"]);
    expect(roofing.at(-1)?.sections.map((s) => s.id)).toEqual(["serviceArea", "contact"]);
    const plumber = sitePages(SiteDocument.parse(loadFixture("plumber-austin")));
    expect(plumber.at(-1)?.sections.map((s) => s.id)).toEqual(["contact", "serviceArea"]);
    const reversed = { ...FULL, layout: [FULL.layout[0], ...FULL.layout.slice(1).reverse()] } as SiteDocumentInput;
    expect(pagesOf(reversed)).toEqual([["home", ["hero", "testimonials", "trust"]], ["services", ["services", "faq"].reverse()], ["about", ["about"]], ["gallery", ["gallery"]], ["contact", ["serviceArea", "contact"]]]);
  });
});
