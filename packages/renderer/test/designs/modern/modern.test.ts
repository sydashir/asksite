// The Modern design's own rules (A12 design build; the approved mockup modern-v2/r6 and its judges' must-fixes). The
// shared invariants, XSS, html-validate, class-drift and contrast checks run for Modern in the shared suites; these
// pin what makes Modern Modern and what its judges asked for.
import { FONT_IDS, PALETTE_IDS, type HideableSectionId, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { FIXTURE_FORM_ACTION, FIXTURES, inDesign, loadFixture, stubStylesheets, type FixtureName } from "../../../../../fixtures/index.ts";
import { AA_LARGE_TEXT, contrastRatio, hexToRgb } from "../../../src/contrast.ts";
import { balancedColumns } from "../../../src/designs/modern/sections.ts";
import { contactHeading, ctaLabels, groupedHours } from "../../../src/designs/modern/text.ts";
import { MODERN_COLORS, MODERN_FONTS, modernVariables } from "../../../src/designs/modern/tokens.ts";
import { render } from "../../../src/index.ts";
import { startTags } from "../../support/page-safety.ts";

const OPTIONS = { stylesheets: stubStylesheets(), formAction: FIXTURE_FORM_ACTION };
const modern = (input: SiteDocumentInput): string => render(inDesign(input, "modern"), OPTIONS).html;
const fixture = (name: FixtureName): string => modern(loadFixture(name));
const withFacts = (input: SiteDocumentInput, facts: Partial<SiteDocumentInput["facts"]>): SiteDocumentInput => ({ ...input, facts: { ...input.facts, ...facts } });
const withHidden = (input: SiteDocumentInput, hidden: HideableSectionId[]): SiteDocumentInput => ({ ...input, hidden });
const withoutHeroPhoto = (input: SiteDocumentInput): SiteDocumentInput => {
  const { heroPhoto: _photo, ...facts } = input.facts;
  return { ...input, facts };
};

/** The markup of the element that starts at `<tag … class="…name…"`, up to its matching end tag. */
function element(page: string, start: string): string {
  const from = page.indexOf(start);
  if (from === -1) return "";
  const tag = /^<([a-z0-9]+)/.exec(start)?.[1] ?? "";
  let depth = 0;
  for (const match of page.slice(from).matchAll(new RegExp(`<(/?)${tag}\\b[^>]*>`, "g"))) {
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return page.slice(from, from + (match.index ?? 0) + match[0].length);
  }
  return page.slice(from);
}
const hero = (page: string) => element(page, '<section id="top"');
const imageSources = (markup: string) => startTags(markup).filter((t) => t.name === "img").map((t) => t.attributes.find((a) => a.name === "src")?.value);

describe("Modern: the call bar's labels come from the owner's call to action", () => {
  it.each([
    ["Get a free quote", "Free quote", "Quote"],
    ["Book a visit", "Book a visit", "Book"],
    ["Book", "Book", "Book"],
    ["Free estimate", "Free estimate", "Estimate"],
    ["Request an estimate", "Estimate", "Estimate"],
    ["Schedule a free estimate", "Schedule", "Schedule"],
    ["Call us today", "Contact us", "Contact"],
    ["Get your free roof inspection", "Inspection", "Contact"],
    ["<a href=javascript:x>", "Contact us", "Contact"],
  ])("%s gives %s, and %s below 340 px", (cta, short, tiny) => {
    expect(ctaLabels(cta)).toEqual({ short, tiny });
  });

  it("never gives a label wider than the bar has room for", () => {
    for (const cta of ["Get a free quote", "Schedule a free estimate", "Supercalifragilisticexpi", "Book now please thanks", "x"]) {
      const { short, tiny } = ctaLabels(cta);
      expect(short.length).toBeLessThanOrEqual(13);
      expect(tiny.length).toBeLessThanOrEqual(9);
    }
  });

  it("the contact heading is the call to action, or 'Get in touch' for one word or a call verb", () => {
    expect(contactHeading("Get a free quote")).toBe("Get a free quote");
    expect(contactHeading("Book")).toBe("Get in touch");
    expect(contactHeading("Call now")).toBe("Get in touch");
  });
});

describe("Modern: small layout helpers", () => {
  it("groups consecutive days with the same hours", () => {
    const hours = [
      { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "07:30", closes: "18:00" },
      { days: ["Saturday"], opens: "08:00", closes: "14:00" },
    ] as const;
    expect(groupedHours(hours.map((h) => ({ ...h, days: [...h.days] })))).toEqual([
      { days: "Monday – Friday", time: "7:30 AM – 6:00 PM" },
      { days: "Saturday", time: "8:00 AM – 2:00 PM" },
      { days: "Sunday", time: "Closed" },
    ]);
  });

  it("balances card rows: no lone card in the last row where it can be avoided", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 12].map((n) => balancedColumns(n, 3))).toEqual([1, 2, 3, 2, 3, 3, 3, 3, 3]);
    expect([4, 7, 8, 12].map((n) => balancedColumns(n, 4))).toEqual([4, 4, 4, 4]);
  });
});

describe("Modern: every owner photo shows once (judges' must-fix)", () => {
  it.each([...FIXTURES])("%s repeats no photo, and About has none", (name) => {
    const page = fixture(name);
    const sources = imageSources(page);
    expect(new Set(sources).size).toBe(sources.length);
    expect(imageSources(element(page, '<section id="about"'))).toEqual([]);
  });

  it("a page without a hero photo repeats no gallery photo either", () => {
    const page = modern(withoutHeroPhoto(loadFixture("plumber-austin")));
    const sources = imageSources(page);
    expect(sources).toHaveLength(6);
    expect(new Set(sources).size).toBe(6);
  });
});

describe("Modern: the credentials", () => {
  it("sit inside the hero, under the headline, when the trust section follows the hero", () => {
    const top = hero(fixture("plumber-austin"));
    expect(top.indexOf('<section id="credentials"')).toBeGreaterThan(top.indexOf("</h1>"));
    for (const fact of ["License M-40123", "Texas master plumber", "Insured", "Since 1998", "Free estimates"]) expect(top).toContain(fact);
  });

  it("are a band of their own wherever else the layout puts them", () => {
    const page = fixture("hvac-phoenix");
    expect(hero(page)).not.toContain("credentials");
    const band = element(page, '<section id="credentials"');
    expect(page.indexOf('<section id="credentials"')).toBeGreaterThan(page.indexOf('<section id="services"'));
    for (const fact of ["License ROC 999001", "License ROC 999002", "Insured", "Since 2011", "24/7 emergency service"]) expect(band).toContain(fact);
  });

  it("leave the hero when the owner hides them", () => {
    const top = hero(modern(withHidden(loadFixture("plumber-austin"), ["trust"])));
    expect(top).not.toContain("Insured");
    expect(top).not.toContain("License");
  });

  it("show two licenses in the hero and link the rest to the footer, which lists them all", () => {
    const page = fixture("roofing-extreme");
    const top = hero(page);
    expect(top.match(/License RCAT/g)).toHaveLength(2);
    expect(top).toMatch(/<a href="#licenses">3 more licenses<svg/);
    const footer = element(page, "<footer");
    expect(footer).toContain('id="licenses"');
    expect(footer.match(/License RCAT/g)).toHaveLength(5);
  });
});

describe("Modern: a hero without a photo", () => {
  const noPhoto = withoutHeroPhoto(loadFixture("plumber-austin"));

  it("shows the opening hours in its card, and the service area section shows the places only", () => {
    const page = modern(noPhoto);
    expect(hero(page)).toContain("Office hours");
    expect(hero(page)).toContain("7:30 AM – 6:00 PM");
    const area = element(page, '<section id="service-area"');
    expect(area).toContain(">Service area<");
    expect(area).not.toContain("7:30 AM");
  });

  it("shows no hours when the owner hides the service area section", () => {
    expect(hero(modern(withHidden(noPhoto, ["serviceArea"])))).not.toContain("7:30 AM");
  });

  it("with a photo, the hours stay in the service area section", () => {
    const page = fixture("plumber-austin");
    expect(hero(page)).not.toContain("7:30 AM");
    expect(element(page, '<section id="service-area"')).toContain("Service area &amp; hours");
  });
});

describe("Modern: services are priced cards", () => {
  it("say 'Price on request' only where another service has a price", () => {
    expect(fixture("plumber-austin").match(/Price on request/g)).toHaveLength(2);
    expect(fixture("cleaning-minimal")).not.toContain("Price on request");
    expect(fixture("cleaning-minimal")).toContain("Ask us for a price.");
  });

  it("take the balanced column count for the number of services", () => {
    expect(fixture("plumber-austin")).toContain('class="cards cards--c3"');
    expect(fixture("hvac-phoenix")).toContain('class="cards cards--c4 cards--compact"');
    expect(fixture("cleaning-minimal")).toContain('class="cards cards--c2"');
  });
});

describe("Modern: the page's custom properties", () => {
  it("carry Modern's own colours for every palette and a distinct display face for every lettering", () => {
    for (const palette of PALETTE_IDS) {
      for (const font of FONT_IDS) {
        const variables = modernVariables({ palette, font });
        expect(variables["--aw-modern-brand"]).toBe(MODERN_COLORS[palette].brand);
        expect(variables["--aw-modern-display"]).toBe(MODERN_FONTS[font].display);
      }
    }
    expect(new Set(FONT_IDS.map((font) => MODERN_FONTS[font].display)).size).toBe(FONT_IDS.length);
  });

  it("use system fonts only", () => {
    for (const font of FONT_IDS) expect(JSON.stringify(MODERN_FONTS[font])).not.toMatch(/url\(|https?:|@import|@font-face/);
  });
});

describe("Modern: non-text contrast (WCAG 1.4.11, 3:1)", () => {
  const WHITE = "#FFFFFF";
  it.each(PALETTE_IDS)("%s: icons, field borders, focus rings and the open FAQ key", (palette) => {
    const c = MODERN_COLORS[palette];
    const pairs: Array<[string, string, string]> = [
      ["field border on white", c.field, WHITE],
      ["FAQ key border on the tint", c.field, c.tint],
      ["icons and focus ring on white", c.brand, WHITE],
      ["icons and focus ring on the tint", c.brand, c.tint],
      ["icon on the Emergencies note", c.brand, c.well],
      ["icons on the brand band", c.bandAccent, c.brand],
      ["focus ring and the open FAQ key's bars on the brand colour", WHITE, c.brand],
    ];
    for (const [label, fg, bg] of pairs) expect(contrastRatio(hexToRgb(fg), hexToRgb(bg)), label).toBeGreaterThanOrEqual(AA_LARGE_TEXT);
  });
});
