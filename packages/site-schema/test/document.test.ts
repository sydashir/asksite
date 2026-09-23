import { describe, expect, it } from "vitest";
import { factSections, Facts, SiteDocument, type SiteDocumentInput } from "../src/index.ts";

const doc: SiteDocumentInput = {
  facts: {
    businessName: "Mop",
    trade: "cleaning",
    phone: "+15125550142",
    email: "hello@example.com",
    location: { city: "Austin", state: "TX" },
    serviceArea: { places: ["Austin"] },
    services: [{ name: "House cleaning" }, { name: "Move-out cleaning" }],
  },
  copy: {
    heroHeadline: "A spotless home without lifting a finger",
    heroSubheadline: "Friendly, careful cleaners for homes across Austin.",
    ctaText: "Book a cleaning",
    serviceDescriptions: [
      { service: "House cleaning", description: "Weekly or one-off cleans." },
      { service: "Move-out cleaning", description: "Get your deposit back." },
    ],
  },
  layout: [
    { id: "hero", variant: "centered" },
    { id: "services", variant: "cards" },
    { id: "serviceArea", variant: "split" },
    { id: "contact", variant: "card" },
  ],
  theme: { palette: "green-amber", font: "clean" },
};

const issues = (input: unknown) => {
  const result = SiteDocument.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("SiteDocument", () => {
  it("parses a complete document", () => {
    expect(issues(doc)).toEqual([]);
  });

  it("rejects an unknown section or variant", () => {
    expect(issues({ ...doc, layout: [{ id: "hero", variant: "video" }] })).toHaveLength(1);
    expect(issues({ ...doc, layout: [...doc.layout, { id: "blog", variant: "grid" }] })).toHaveLength(1);
  });

  it("requires the hero first and forbids duplicates", () => {
    expect(issues({ ...doc, layout: doc.layout.slice(1) })).toEqual(["layout: The first section must be the hero"]);
    expect(issues({ ...doc, layout: [...doc.layout, { id: "contact", variant: "card" }] })).toEqual([
      "layout: Each section may appear only once",
    ]);
  });

  it("rejects an unknown palette or font", () => {
    expect(issues({ ...doc, theme: { palette: "hot-pink", font: "clean" } })).toHaveLength(1);
    expect(issues({ ...doc, theme: { palette: "navy-orange", font: "comic" } })).toHaveLength(1);
  });

  it("needs one service description per owner service, named and in order", () => {
    const [first, second] = doc.copy.serviceDescriptions;
    const message = "copy.serviceDescriptions: copy.serviceDescriptions must name every facts.services entry once, in the same order";
    expect(issues({ ...doc, copy: { ...doc.copy, serviceDescriptions: [first] } })).toEqual([message]);
    expect(issues({ ...doc, copy: { ...doc.copy, serviceDescriptions: [second, first] } })).toEqual([message]);
  });

  it("never lets the layout hide owner facts", () => {
    expect(issues({ ...doc, layout: [{ id: "hero", variant: "centered" }, { id: "services", variant: "cards" }] })).toEqual([
      "layout: The layout must include every section that shows owner facts; missing: serviceArea, contact",
    ]);
    const reviewed = { ...doc, facts: { ...doc.facts, testimonials: [{ quote: "Spotless.", name: "Ana" }] } };
    expect(issues(reviewed)).toEqual(["layout: The layout must include every section that shows owner facts; missing: testimonials"]);
  });

  it("lists the fact sections for the facts given", () => {
    expect(factSections(Facts.parse(doc.facts))).toEqual(["services", "serviceArea", "contact"]);
    expect(factSections(Facts.parse({ ...doc.facts, insured: true, photos: [] }))).toEqual([
      "services",
      "serviceArea",
      "contact",
      "trust",
    ]);
  });

  it("rejects copy that states a claim the facts do not back", () => {
    expect(issues({ ...doc, copy: { ...doc.copy, ctaText: "Get a free quote" } })).toEqual([
      'copy.ctaText: Copy states something the owner\'s facts do not back: "free"',
    ]);
    const free = { ...doc, facts: { ...doc.facts, freeEstimates: true }, copy: { ...doc.copy, ctaText: "Get a free quote" } };
    expect(issues(free)).toEqual([]);
  });

  it("keeps facts out of copy and copy out of facts", () => {
    expect(issues({ ...doc, copy: { ...doc.copy, phone: "+15125550142" } })).toHaveLength(1);
    expect(issues({ ...doc, facts: { ...doc.facts, heroHeadline: "x" } })).toHaveLength(1);
  });
});
