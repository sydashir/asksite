import { describe, expect, it } from "vitest";
import { HIDEABLE_SECTIONS, OwnerHidden, SiteDocument, type SiteDocumentInput } from "../src/index.ts";

// Amendment A6: owner-hidden sections. Only the owner sets `hidden`; hero, services and contact
// can never be hidden, so every page says what the business does and how to reach it.
const doc: SiteDocumentInput = {
  facts: {
    businessName: "Mop",
    trade: "cleaning",
    phone: "+15125550142",
    email: "hello@example.com",
    location: { city: "Austin", state: "TX" },
    serviceArea: { places: ["Austin"] },
    services: [{ name: "House cleaning" }],
    testimonials: [{ quote: "Spotless every time.", name: "Ana" }],
  },
  copy: {
    heroHeadline: "A spotless home without lifting a finger",
    heroSubheadline: "Friendly, careful cleaners for homes across Austin.",
    ctaText: "Book a cleaning",
    serviceDescriptions: [{ service: "House cleaning", description: "Weekly or one-off cleans." }],
  },
  layout: [
    { id: "hero", variant: "centered" },
    { id: "services", variant: "cards" },
    { id: "testimonials", variant: "grid" },
    { id: "serviceArea", variant: "split" },
    { id: "contact", variant: "card" },
  ],
  theme: { palette: "green-amber", font: "clean" },
};

const issues = (input: unknown) => {
  const result = SiteDocument.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("SiteDocument.hidden (A6)", () => {
  it("defaults to an empty list, so documents without it parse as before", () => {
    expect(SiteDocument.parse(doc).hidden).toEqual([]);
  });

  it("lists exactly the six hideable sections", () => {
    expect(HIDEABLE_SECTIONS).toEqual(["trust", "testimonials", "gallery", "about", "serviceArea", "faq"]);
  });

  it("accepts hideable sections, including a fact section the layout must still list", () => {
    expect(issues({ ...doc, hidden: ["testimonials", "faq"] })).toEqual([]);
  });

  it.each(["hero", "services", "contact"])("rejects hiding %s", (id) => {
    expect(issues({ ...doc, hidden: [id] })).toHaveLength(1);
    expect(issues({ ...doc, hidden: [id] })[0]).toMatch(/^hidden\.0: /);
  });

  it("rejects an unknown section id", () => {
    expect(issues({ ...doc, hidden: ["header"] })).toHaveLength(1);
  });

  it("rejects a duplicate id", () => {
    expect(issues({ ...doc, hidden: ["faq", "faq"] })).toEqual(["hidden: A section can be hidden only once"]);
  });

  it("does not let hiding remove a fact section from the layout rule", () => {
    const withoutReviews = { ...doc, layout: doc.layout.filter((s) => s.id !== "testimonials"), hidden: ["testimonials"] };
    expect(issues(withoutReviews)).toEqual([
      "layout: The layout must include every section that shows owner facts; missing: testimonials",
    ]);
  });

  it("OwnerHidden caps the list at the number of hideable sections", () => {
    expect(OwnerHidden.safeParse([...HIDEABLE_SECTIONS, "faq"]).success).toBe(false);
  });
});
