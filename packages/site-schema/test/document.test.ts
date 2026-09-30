import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  DEFAULT_DESIGN,
  DESIGN_IDS,
  factSections,
  Facts,
  SiteDocument,
  Theme,
  ThemeChoice,
  type DesignId,
  type SiteDocumentInput,
} from "../src/index.ts";

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

  it("gives a stored theme without a design the default design, and keeps a named one (A12)", () => {
    expect(SiteDocument.parse(doc).theme).toEqual({ palette: "green-amber", font: "clean", design: "impact" });
    expect(SiteDocument.parse({ ...doc, theme: { ...doc.theme, design: "modern" } }).theme.design).toBe("modern");
    expect(issues({ ...doc, theme: { ...doc.theme, design: "brutalist" } })).toEqual([
      'theme.design: Invalid option: expected one of "impact"|"refined"|"modern"',
    ]);
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

  it("never lets the layout hide the owner's gallery when there are photos", () => {
    const photos = [{ url: "https://example.com/a.jpg", alt: "Finished job", width: 800, height: 600 }];
    const withPhotos = { ...doc, facts: { ...doc.facts, photos } };
    expect(issues(withPhotos)).toEqual(["layout: The layout must include every section that shows owner facts; missing: gallery"]);
    expect(issues({ ...withPhotos, layout: [...doc.layout, { id: "gallery", variant: "grid" }] })).toEqual([]);
  });

  it("never lets the layout hide the owner's hero photo, whatever hero variant the AI picks", () => {
    const heroPhoto = { url: "https://example.com/hero.jpg", alt: "Our team cleaning a kitchen", width: 1200, height: 800 };
    const withHeroPhoto = { ...doc, facts: { ...doc.facts, heroPhoto } };
    expect(doc.layout[0]).toEqual({ id: "hero", variant: "centered" });
    expect(issues(withHeroPhoto)).toEqual([]);
    expect(SiteDocument.parse(withHeroPhoto).layout).toEqual([{ id: "hero", variant: "photo" }, ...doc.layout.slice(1)]);
    // Without a hero photo both variants render the same text-only hero, so the AI's choice stands.
    expect(SiteDocument.parse(doc).layout).toEqual(doc.layout);
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

  it.each([
    ["licences", { licences: [{ label: "Texas RMP", number: "TX-1" }] }],
    ["insured", { insured: true }],
    ["yearFounded", { yearFounded: 1998 }],
    ["emergency247", { emergency247: true }],
  ] as const)("adds trust when only %s is set", (_fact, patch) => {
    expect(factSections(Facts.parse({ ...doc.facts, ...patch }))).toEqual(["services", "serviceArea", "contact", "trust"]);
  });

  it("adds gallery for photos and testimonials for testimonials, each on its own", () => {
    const photos = [{ url: "https://example.com/a.jpg", alt: "Finished job", width: 800, height: 600 }];
    expect(factSections(Facts.parse({ ...doc.facts, photos }))).toEqual(["services", "serviceArea", "contact", "gallery"]);
    const testimonials = [{ quote: "Spotless every time.", name: "Ana" }];
    expect(factSections(Facts.parse({ ...doc.facts, testimonials }))).toEqual(["services", "serviceArea", "contact", "testimonials"]);
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

describe("page designs (A12)", () => {
  const colours = { palette: "navy-orange", font: "clean" } as const;
  const problems = (schema: typeof Theme | typeof ThemeChoice, input: unknown) => {
    const result = schema.safeParse(input);
    return result.success ? [] : result.error.issues.map((i) => ({ path: i.path, code: i.code, message: i.message }));
  };
  const unknownDesign = [{ path: ["design"], code: "invalid_value", message: 'Invalid option: expected one of "impact"|"refined"|"modern"' }];

  it("has three permanent design ids, and impact is the default", () => {
    expect(DESIGN_IDS).toEqual(["impact", "refined", "modern"]);
    expect(DEFAULT_DESIGN).toBe("impact");
    expectTypeOf<DesignId>().toEqualTypeOf<"impact" | "refined" | "modern">();
  });

  it("Theme (stored data) fills the default design; ThemeChoice (incoming data) requires one", () => {
    expect(Theme.parse(colours)).toEqual({ ...colours, design: "impact" });
    expect(problems(ThemeChoice, colours)).toEqual(unknownDesign);
    for (const design of DESIGN_IDS) {
      expect(Theme.parse({ ...colours, design })).toEqual({ ...colours, design });
      expect(ThemeChoice.parse({ ...colours, design })).toEqual({ ...colours, design });
    }
  });

  it("both refuse an unknown design, a design of the wrong type and an unknown key", () => {
    for (const schema of [Theme, ThemeChoice]) {
      expect(problems(schema, { ...colours, design: "brutalist" })).toEqual(unknownDesign);
      expect(problems(schema, { ...colours, design: "Impact" })).toEqual(unknownDesign);
      expect(problems(schema, { ...colours, design: null })).toEqual(unknownDesign);
      expect(problems(schema, { ...colours, design: "impact", layout: "grid" }).map((i) => i.code)).toEqual(["unrecognized_keys"]);
    }
  });

  it("types the stored and the incoming theme alike once parsed", () => {
    expectTypeOf<z.output<typeof Theme>>().toEqualTypeOf<z.output<typeof ThemeChoice>>();
    expectTypeOf<z.input<typeof Theme>["design"]>().toEqualTypeOf<DesignId | undefined>();
    expectTypeOf<z.input<typeof ThemeChoice>["design"]>().toEqualTypeOf<DesignId>();
  });
});
