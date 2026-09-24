import { SiteDocument } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { visibleSections } from "../src/visibility.ts";
import { FULL, MINIMAL } from "./support/doc.ts";

describe("visibleSections", () => {
  it("keeps every section that has content, in layout order", () => {
    expect(visibleSections(SiteDocument.parse(FULL)).map((s) => s.id)).toEqual([
      "hero",
      "trust",
      "services",
      "testimonials",
      "gallery",
      "about",
      "serviceArea",
      "faq",
      "contact",
    ]);
  });

  it("hides sections whose optional facts or copy are missing", () => {
    expect(visibleSections(SiteDocument.parse(MINIMAL)).map((s) => s.id)).toEqual([
      "hero",
      "services",
      "serviceArea",
      "contact",
    ]);
  });

  it("shows the trust strip for any single credential", () => {
    const withInsured = { ...MINIMAL, facts: { ...MINIMAL.facts, insured: true } };
    expect(visibleSections(SiteDocument.parse(withInsured)).map((s) => s.id)).toContain("trust");
  });
});
