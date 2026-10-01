import { SiteDocument, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { FIXTURE_SITE_URL, stubStylesheets } from "../../../fixtures/index.ts";
import { render as renderPage } from "../src/index.ts";
import { visibleSections } from "../src/visibility.ts";
import { FULL } from "./support/doc.ts";

// Amendment A6: a section the owner hid is gone from <main>, the header navigation and (for the
// FAQ) the FAQPage JSON-LD. LocalBusiness JSON-LD is unchanged: hiding hides, it deletes no facts.
const OPTIONS = { stylesheets: stubStylesheets("/* css */"), formAction: "https://forms.example.com/submit", siteUrl: FIXTURE_SITE_URL };
const render = (input: SiteDocumentInput, options: typeof OPTIONS) => renderPage(input, options).pages[0]!.html;
const sectionIds = (page: string) => [...page.matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1]);
const withHidden = (hidden: string[]): SiteDocumentInput => ({ ...FULL, hidden } as SiteDocumentInput);

describe("owner-hidden sections (A6)", () => {
  it("visibleSections drops hidden sections and keeps the rest in order", () => {
    const doc = SiteDocument.parse(withHidden(["testimonials", "faq"]));
    expect(visibleSections(doc).map((s) => s.id)).toEqual(["hero", "trust", "services", "gallery", "about", "serviceArea", "contact"]);
  });

  it("removes a hidden section from <main> and the navigation", () => {
    const page = render(withHidden(["testimonials", "gallery"]), OPTIONS);
    expect(sectionIds(page)).toEqual(["top", "credentials", "services", "about", "service-area", "faq", "contact"]);
    expect(page).not.toContain('href="#reviews"');
    expect(page).not.toContain('href="#our-work"');
    expect(page).toContain('href="#services"');
  });

  it("drops FAQPage JSON-LD with a hidden FAQ but keeps LocalBusiness JSON-LD", () => {
    const page = render(withHidden(["faq"]), OPTIONS);
    expect(page).not.toContain('"@type":"FAQPage"');
    expect(page).not.toContain('<section id="faq"');
    expect(page).toContain('"@type":"Plumber"');
    expect(page).toContain("M-40123");
  });

  it("renders byte-for-byte the same page with hidden: [] as without the field", () => {
    expect(render(withHidden([]), OPTIONS)).toBe(render(FULL, OPTIONS));
  });
});
