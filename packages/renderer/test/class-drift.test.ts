import { DESIGN_IDS, SECTION_VARIANTS, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { inDesign, stubStylesheets } from "../../../fixtures/index.ts";
import { render } from "../src/index.ts";
import { loadCompiledCss, missingClasses } from "./support/css-classes.ts";
import { FULL, MINIMAL } from "./support/doc.ts";

// Renders every section variant with 1, 2, 3, 4 and 12 items in every design, so every branch of every
// class lookup table is exercised, then checks each class against that design's compiled stylesheet.
const COUNTS = [1, 2, 3, 4, 12];
const VARIANT_INDEXES = Array.from({ length: Math.max(...Object.values(SECTION_VARIANTS).map((v) => v.length)) }, (_, i) => i);
const OPTIONS = { stylesheets: stubStylesheets(""), formAction: "https://forms.example.com/submit" };

function layoutUsingVariant(index: number): SiteDocumentInput["layout"] {
  return Object.entries(SECTION_VARIANTS).map(([id, variants]) => ({ id, variant: variants[Math.min(index, variants.length - 1)] })) as SiteDocumentInput["layout"];
}

function withCount(count: number, variantIndex: number): SiteDocumentInput {
  const photo = { url: "https://images.example.com/p.jpg", alt: "A finished job", width: 1200, height: 900, caption: "Caption" };
  const services = Array.from({ length: count }, (_, i) => ({ name: `Service ${String.fromCharCode(65 + i)}`, startingPrice: 50 + i }));
  return {
    ...FULL,
    facts: {
      ...FULL.facts,
      services,
      testimonials: Array.from({ length: count }, (_, i) => ({ quote: "Great work.", name: `Customer ${String.fromCharCode(65 + i)}` })),
      photos: Array.from({ length: count }, () => photo),
    },
    copy: { ...FULL.copy, serviceDescriptions: services.map((s) => ({ service: s.name, description: "A careful job." })) },
    layout: layoutUsingVariant(variantIndex),
  };
}

describe.each(DESIGN_IDS)("class drift in the %s design", (design) => {
  it("every class in every variant and item count exists in the design's compiled CSS", () => {
    const pages = [render(inDesign(MINIMAL, design), OPTIONS).html];
    for (const variantIndex of VARIANT_INDEXES) {
      for (const count of COUNTS) pages.push(render(inDesign(withCount(count, variantIndex), design), OPTIONS).html);
    }
    expect(VARIANT_INDEXES.length).toBeGreaterThan(1);
    expect(pages.flatMap((page) => missingClasses(page, loadCompiledCss(design)))).toEqual([]);
  });
});
