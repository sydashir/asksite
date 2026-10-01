import { SiteDocument, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { FIXTURE_SITE_URL, stubStylesheets } from "../../../fixtures/index.ts";
import { render as renderPage } from "../src/index.ts";
import { visibleSections } from "../src/visibility.ts";
import { FULL } from "./support/doc.ts";

// Amendment A6: a section the owner hid is gone from <main>, the header navigation and (for the
// FAQ) the FAQPage JSON-LD. LocalBusiness JSON-LD is unchanged: hiding hides, it deletes no facts.
const OPTIONS = { stylesheets: stubStylesheets("/* css */"), formAction: "https://forms.example.com/submit", siteUrl: FIXTURE_SITE_URL };
const renderSite = (input: SiteDocumentInput, options: typeof OPTIONS) => renderPage(input, options);
const sectionIds = (page: string) => [...page.matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1]);
const withHidden = (hidden: string[]): SiteDocumentInput => ({ ...FULL, hidden } as SiteDocumentInput);

describe("owner-hidden sections (A6)", () => {
  it("visibleSections drops hidden sections and keeps the rest in order", () => {
    const doc = SiteDocument.parse(withHidden(["testimonials", "faq"]));
    expect(visibleSections(doc).map((s) => s.id)).toEqual(["hero", "trust", "services", "about", "gallery", "contact", "serviceArea"]);
  });

  it("removes a hidden section from <main> and the navigation, and a page left with no section from the site", () => {
    const site = renderSite(withHidden(["testimonials", "gallery"]), OPTIONS);
    expect(site.pages.map((p) => p.page)).toEqual(["home", "services", "about", "contact"]);
    expect(site.pages.map((p) => sectionIds(p.html))).toEqual([
      ["top", "credentials", "services-preview", "get-in-touch"],
      ["services", "faq", "get-in-touch"],
      ["about", "get-in-touch"],
      ["contact", "service-area"],
    ]);
    for (const { html } of site.pages) {
      for (const gone of ['href="#reviews"', 'href="/gallery"', "#our-work", 'id="our-work"', 'id="reviews"']) expect(html).not.toContain(gone);
      expect(html).toContain('href="/services"');
    }
  });

  it("removes a hidden About page, its nav link, every link to it and its section id from every page", () => {
    const site = renderSite(withHidden(["about"]), OPTIONS);
    expect(site.pages.map((p) => p.page)).toEqual(["home", "services", "gallery", "contact"]);
    for (const { html } of site.pages) {
      for (const gone of ['href="/about"', "#about", 'id="about"', 'id="about-title"']) expect(html).not.toContain(gone);
      expect(html).toContain('href="/gallery"');
    }
    expect(renderSite(FULL, OPTIONS).pages.every((p) => p.html.includes('href="/about"'))).toBe(true);
  });

  it("drops FAQPage JSON-LD with a hidden FAQ but keeps LocalBusiness JSON-LD", () => {
    const site = renderSite(withHidden(["faq"]), OPTIONS);
    const all = site.pages.map((p) => p.html).join("");
    expect(all).not.toContain('"@type":"FAQPage"');
    expect(all).not.toContain('<section id="faq"');
    expect(site.pages[0]?.html).toContain('"@type":"Plumber"');
    expect(site.pages[0]?.html).toContain("M-40123");
  });

  it("renders byte-for-byte the same site with hidden: [] as without the field", () => {
    expect(renderSite(withHidden([]), OPTIONS)).toEqual(renderSite(FULL, OPTIONS));
  });
});
