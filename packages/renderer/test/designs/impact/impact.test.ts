import { HIDEABLE_SECTIONS, type SectionId, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { DESIGN_CSS, FIXTURE_FORM_ACTION, inDesign, loadFixture, stubStylesheets, type FixtureName } from "../../../../../fixtures/index.ts";
import {
  brandClass,
  buttonCase,
  capsWidth,
  contactHeading,
  galleryClass,
  groupedHours,
  headlineClass,
  licenceParts,
  seamClass,
  shortCta,
  surfaces,
  yearClass,
} from "../../../src/designs/impact/rules.ts";
import { render } from "../../../src/render.ts";

const NBSP = " ";
const OPTIONS = { stylesheets: stubStylesheets(), formAction: FIXTURE_FORM_ACTION };
const bold = (input: SiteDocumentInput) => render(inDesign(input, "impact"), OPTIONS).html;
const fixture = (name: FixtureName) => loadFixture(name);
const plumber = fixture("plumber-austin");

function withoutPhotos(input: SiteDocumentInput): SiteDocumentInput {
  const { heroPhoto: _photo, ...facts } = input.facts;
  return { ...input, facts: { ...facts, photos: [] } };
}

describe("Bold page rules", () => {
  it("picks the headline size by length: capitals up to 40 characters, then two mixed-case steps", () => {
    expect(headlineClass("x".repeat(40))).toBe("h1 display");
    expect(headlineClass("x".repeat(41))).toBe("h1 display h1--long");
    expect(headlineClass("x".repeat(60))).toBe("h1 display h1--long");
    expect(headlineClass("x".repeat(61))).toBe("h1 display h1--xlong");
    expect(headlineClass("é".repeat(40))).toBe("h1 display");
  });

  it("gives a business name over 28 characters the smaller brand size", () => {
    expect(brandClass("x".repeat(28))).toBe("brand");
    expect(brandClass("x".repeat(29))).toBe("brand brand--long");
  });

  it("keeps every button in capitals only while the owner's label fits each of its buttons in capitals", () => {
    for (const label of ["Get a free quote", "Book a visit", "Book", "Schedule a free estimate"]) expect(buttonCase(label)).toBe("caps");
    const wide = "WWWW MMMM WWWW MMMM WWW";
    expect(capsWidth(wide, 20) * 1.03).toBeGreaterThan(274);
    expect(buttonCase(wide)).toBe("sentence");
  });

  it("shortens the call to action for the call bar, and words the contact heading", () => {
    expect(shortCta("Get a free quote")).toBe("Get quote");
    expect(shortCta("Book")).toBe("Book");
    expect(shortCta("Book a visit")).toBe("Book");
    expect(shortCta("Schedule a free estimate")).toBe("Estimate");
    expect(shortCta("Call us today")).toBe("Request");
    expect(contactHeading("Get a free quote")).toBe("Get a free quote");
    expect(contactHeading("Book")).toBe("Request a booking");
    expect(contactHeading("Quote.")).toBe("Request a quote");
    expect(contactHeading("Hello")).toBe("Send us a request");
  });

  it("groups the week's hours, with no break inside a time or a day range", () => {
    expect(groupedHours(plumber.facts.hours ?? [])).toEqual([
      { label: `Monday${NBSP}–${NBSP}Friday`, value: `7:30${NBSP}AM${NBSP}– 6:00${NBSP}PM` },
      { label: "Saturday", value: `8:00${NBSP}AM${NBSP}– 2:00${NBSP}PM` },
      { label: "Sunday", value: "Closed" },
    ]);
    expect(groupedHours(fixture("hvac-phoenix").facts.hours ?? [], true)).toEqual([
      { label: `Mon${NBSP}–${NBSP}Fri`, value: `7:00${NBSP}AM${NBSP}– 7:00${NBSP}PM` },
      { label: `Sat${NBSP}–${NBSP}Sun`, value: `Open 24${NBSP}hours` },
    ]);
    expect(groupedHours([])).toEqual([{ label: `Monday${NBSP}–${NBSP}Sunday`, value: "Closed" }]);
  });

  it("never shows a licence code twice, and never changes the number", () => {
    expect(licenceParts({ label: "Arizona ROC", number: "ROC 999001" })).toEqual({ label: "Arizona", number: "ROC 999001" });
    expect(licenceParts({ label: "California C-10", number: "C-10 123456" })).toEqual({ label: "California", number: "C-10 123456" });
    expect(licenceParts({ label: "ROC", number: "ROC 1" })).toEqual({ label: "", number: "ROC 1" });
    expect(licenceParts({ label: "Texas master plumber", number: "M-40123" })).toEqual({ label: "Texas master plumber", number: "M-40123" });
  });

  it("lays the gallery out by photo count and shifts a founding year's leading 1 or 2", () => {
    expect([1, 2, 3, 4, 5, 6, 12].map(galleryClass)).toEqual(["gal gal--solo", "gal gal--f1", "gal gal--f2", "gal gal--f3", "gal gal--f1", "gal gal--f2", "gal gal--f2"]);
    expect([1998, 2011, 3000].map(yearClass)).toEqual(["year-n display year-n--1", "year-n display year-n--2", "year-n display"]);
  });
});

// Every page shape a document can have: the hero first, then any order of the other sections, with any set of
// the owner-hideable ones left out (84,158 shapes). The credentials straight under the hero are the hero's card.
function* shapes(): Generator<SectionId[]> {
  const rest: SectionId[] = ["trust", "services", "testimonials", "gallery", "about", "serviceArea", "faq", "contact"];
  const permutations = function* (items: SectionId[]): Generator<SectionId[]> {
    if (items.length <= 1) yield items;
    else for (let i = 0; i < items.length; i++) for (const tail of permutations([...items.slice(0, i), ...items.slice(i + 1)])) yield [items[i] as SectionId, ...tail];
  };
  for (let mask = 0; mask < 1 << HIDEABLE_SECTIONS.length; mask++) {
    const kept = rest.filter((id) => !HIDEABLE_SECTIONS.some((h, bit) => h === id && (mask >> bit) % 2 === 1));
    for (const order of permutations(kept)) yield ["hero", ...order];
  }
}

describe("Bold surfaces", () => {
  it("in every page shape: never more than two light bands in a row, ink only beside ink when both are fixed, light neighbours in two tones, seams only on light bands", () => {
    const problems: string[] = [];
    let count = 0;
    for (const sections of shapes()) {
      count++;
      const flow = sections[1] === "trust" ? sections.filter((id) => id !== "trust") : sections;
      const surface = surfaces(flow);
      let light = 0;
      for (const id of [...flow, undefined]) {
        light = id === undefined || surface.get(id) === "ink" ? 0 : light + 1;
        if (light > 2) problems.push(`three light bands: ${flow.join(",")}`);
      }
      flow.forEach((id, i) => {
        const next = flow[i + 1];
        if (next === undefined) return;
        const [a, b] = [surface.get(id), surface.get(next)];
        if (a === "ink" && b === "ink" && !(["hero", "contact"].includes(id) && ["hero", "contact"].includes(next))) problems.push(`ink beside ink: ${flow.join(",")}`);
        if (a !== "ink" && a === b) problems.push(`same light tone: ${flow.join(",")}`);
      });
      for (const id of flow) if (surface.get(id) === "ink" && seamClass(flow, surface, id) !== "") problems.push(`seam on an ink band: ${flow.join(",")}`);
      if (surface.get("hero") !== "ink" || (flow.includes("contact") && surface.get("contact") !== "ink")) problems.push(`hero or contact not ink: ${flow.join(",")}`);
      if (problems.length > 5) break;
    }
    expect(problems).toEqual([]);
    expect(count).toBe(84_158);
  });

  it("turns the reviews ink when both neighbours are light, before About", () => {
    const flow: SectionId[] = ["hero", "services", "testimonials", "about", "faq", "contact"];
    const surface = surfaces(flow);
    expect(flow.map((id) => surface.get(id))).toEqual(["ink", "paper", "ink", "tint", "paper", "ink"]);
  });

  it("draws each seam from the light side: up over an ink band above (not the hero), down over an ink band below", () => {
    const flow: SectionId[] = ["hero", "services", "testimonials", "gallery", "faq", "contact"];
    const surface = surfaces(flow);
    expect(flow.map((id) => surface.get(id))).toEqual(["ink", "paper", "ink", "tint", "paper", "ink"]);
    expect(flow.map((id) => seamClass(flow, surface, id))).toEqual(["", " seam-down", "", " seam-up", " seam-down", ""]);
  });
});

describe("the Bold page", () => {
  it("draws the credentials straight under the hero as the hero's own card, and a band elsewhere", () => {
    const page = bold(plumber);
    const hero = page.slice(page.indexOf('<section id="top"'), page.indexOf('<section id="services"'));
    expect(hero).toContain('<section id="credentials" class="proof" aria-label="Credentials">');
    const hvac = bold(fixture("hvac-phoenix"));
    expect(hvac).toContain('<div class="proof">');
    expect(hvac).toMatch(/<section id="credentials" class="sec [a-z -]*sec--rail" aria-label="Credentials">/);
  });

  it("leaves the credentials out of the hero while the owner hides that section", () => {
    const page = bold({ ...plumber, hidden: ["trust"] });
    expect(page).not.toContain('class="proof"');
    expect(page).not.toContain("proof-list");
  });

  it("leads the no-photo hero card's hours with an Emergencies 24/7 row when the owner offers 24/7 service", () => {
    expect(bold(withoutPhotos(plumber))).toContain('<dl class="biz-hours"><div class="biz-247"><dt>Emergencies</dt><dd>24/7</dd></div><div><dt>Mon');
    expect(bold(fixture("hvac-phoenix"))).toContain('<dl class="biz-hours"><div class="biz-247"><dt>Emergencies</dt><dd>24/7</dd></div>');
    // The fixture's FAQ promises help "day or night", which only a 24/7 owner may say, so it goes too.
    const no247 = withoutPhotos({ ...plumber, facts: { ...plumber.facts, emergency247: false }, copy: { ...plumber.copy, faq: [] } });
    expect(bold(no247)).toContain('<dl class="biz-hours"><div><dt>Mon');
    expect(bold(no247)).not.toContain("biz-247");
  });

  it("drops the no-photo hero card while the owner hides the service area it sums up", () => {
    const page = bold({ ...withoutPhotos(plumber), hidden: ["serviceArea"] });
    expect(page).toContain('class="hero hero--type ink"');
    expect(page).not.toContain("biz-slot");
  });

  it("puts the links to more reviews after the quotes", () => {
    const page = bold(plumber);
    const order = ["rev-lead", "rev-grid", "rev-more"].map((name) => page.indexOf(`class="${name}`));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

});

describe("the Bold sheet carries the round-4 must-fixes", () => {
  const css = DESIGN_CSS.impact.css;
  /** Every declaration block of `selector` in the compiled sheet, or only those after the first `media` query. */
  const rule = (selector: string, media?: string) => {
    const scope = media === undefined ? css : css.slice(css.indexOf(media));
    const blocks: string[] = [];
    for (let at = scope.indexOf(`${selector}{`); at !== -1; at = scope.indexOf(`${selector}{`, at + 1)) {
      if (!/[\w-]/.test(scope.charAt(at - 1))) blocks.push(scope.slice(at, scope.indexOf("}", at) + 1));
    }
    return blocks.join("");
  };

  it("sizes every h2 with clamp(1.75rem, 1.25rem + 1.9vw, 3rem)", () => {
    expect(rule(".h2")).toContain("font-size:clamp(1.75rem,1.25rem + 1.9vw,3rem)");
  });

  it("gives the call bar a tight shadow and stacks it below the form's Send button", () => {
    expect(rule(".callbar")).toContain("box-shadow:0 -6px 12px -8px");
    expect(rule(".callbar")).toContain("z-index:10");
    expect(css).toContain("form button[type=submit]{z-index:20;position:relative}");
  });

  it("lines the FAQ up on the page's left edge from 64rem, like every other section", () => {
    expect(rule(".faq-layout", "@media (min-width:64rem)")).toContain('grid-template:"head list""call list"1fr/minmax(0,5fr) minmax(0,7fr)');
  });

  it("never stretches a type-only hero to the window's height", () => {
    expect(css).not.toMatch(/\.hero--type[^{]*\{[^}]*min-height:calc\(100/);
  });

  it("frames the photo at laptop widths, so a wide photo keeps its subject", () => {
    expect(rule(".hero--photo .hero-media", "@media (min-width:64rem) and (max-width:79.99rem)")).toContain("aspect-ratio:4/3");
  });
});
