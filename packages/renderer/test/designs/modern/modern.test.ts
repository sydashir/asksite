// The Modern design's own rules (A12 design build; the approved mockup modern-v2/r6 and its judges' must-fixes). The
// shared invariants, XSS, html-validate, class-drift and contrast checks run for Modern in the shared suites; these
// pin what makes Modern Modern and what its judges asked for.
import { FONT_IDS, PALETTE_IDS, SiteDocument, type HideableSectionId, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { FIXTURE_FORM_ACTION, FIXTURES, inDesign, loadFixture, stubStylesheets, type FixtureName } from "../../../../../fixtures/index.ts";
import { BASELINE } from "../../../src/baseline.ts";
import { AA_LARGE_TEXT, contrastRatio, hexToRgb } from "../../../src/contrast.ts";
import { DESIGNS } from "../../../src/designs/index.ts";
import { cardColumns } from "../../../src/designs/modern/sections.ts";
import { areaSummary, contactHeading, ctaLabels, groupedHours } from "../../../src/designs/modern/text.ts";
import { MODERN_COLORS, MODERN_FONTS, modernVariables } from "../../../src/designs/modern/tokens.ts";
import { render } from "../../../src/index.ts";
import { renderDocument } from "../../../src/render.ts";
import { invariantProblems } from "../../support/design-invariants.ts";
import { startTags } from "../../support/page-safety.ts";

const OPTIONS = { stylesheets: stubStylesheets(), formAction: FIXTURE_FORM_ACTION };
const modern = (input: SiteDocumentInput): string => render(inDesign(input, "modern"), OPTIONS).html;
/** The shared invariants (A12 §7, the honesty rule included) for Modern's page of `input`, against today's page. */
function problems(input: SiteDocumentInput): string[] {
  const doc = SiteDocument.parse(inDesign(input, "modern"));
  return invariantProblems(modern(input), renderDocument(doc, BASELINE, OPTIONS).html, doc, DESIGNS.modern);
}
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

  it("takes the most service columns, up to one more than the services: the call-to-action card fills the last row", () => {
    expect([1, 2, 3, 4, 5, 7, 10, 12].map((n) => cardColumns(n, 3))).toEqual([2, 3, 3, 3, 3, 3, 3, 3]);
    expect([1, 2, 3, 5, 8].map((n) => cardColumns(n, 4))).toEqual([2, 3, 4, 4, 4]);
  });

  it("sums up the service area in a few words: one or two places as the section says them, three by name, more as a count", () => {
    const facts = (places: string[]) => SiteDocument.parse({ ...loadFixture("plumber-austin"), facts: { ...loadFixture("plumber-austin").facts, serviceArea: { places } } }).facts;
    expect(areaSummary(facts(["Austin"]))).toBe("Austin, TX");
    expect(areaSummary(facts(["Kyle", "Austin"]))).toBe("Kyle and Austin, TX");
    expect(areaSummary(facts(["Kyle", "Austin", "Buda"]))).toBe("Kyle, Austin and Buda");
    expect(areaSummary(facts(["Austin", "Round Rock", "Kyle", "Buda", "Hutto"]))).toBe("Austin, Round Rock and 3 more");
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
    const text = top.replace(/<[^>]*>/g, "");
    for (const fact of ["License M-40123", "Texas master plumber", "Insured", "Since 1998", "Free estimates"]) expect(text).toContain(fact);
  });

  it("are a band of their own on the brand colour, with a heading, wherever else the layout puts them", () => {
    const page = fixture("hvac-phoenix");
    expect(hero(page)).not.toContain('id="credentials"');
    const band = element(page, '<section id="credentials"');
    expect(band).toMatch(/^<section id="credentials" class="trust on-brand" aria-labelledby="credentials-title">/);
    expect(band).toContain('<h2 id="credentials-title" class="display h2">Credentials</h2>');
    expect(page.indexOf('<section id="credentials"')).toBeGreaterThan(page.indexOf('<section id="services"'));
    const text = band.replace(/<[^>]*>/g, "");
    for (const fact of ["License ROC 999001", "License ROC 999002", "Insured", "Since 2011", "24/7 emergency service"]) expect(text).toContain(fact);
  });

  it("when they come later, the hero still names the licenses and insurance in one short line", () => {
    const top = hero(fixture("hvac-phoenix"));
    const line = element(top, '<ul class="proof-line"').replace(/<[^>]*>/g, "");
    expect(line).toBe("License ROC 999001License ROC 999002Insured");
    expect(top).not.toContain("Since 2011");
  });

  it("leave the hero when the owner hides them, wherever the layout puts them", () => {
    for (const name of ["plumber-austin", "hvac-phoenix"] as const) {
      const top = hero(modern(withHidden(loadFixture(name), ["trust"])));
      expect(top).not.toContain("Insured");
      expect(top).not.toContain("License");
    }
  });

  it("on phones, two licenses or a long one take whole rows, so the licenses sit together, first", () => {
    const rows = (page: string) => [...hero(page).matchAll(/<li class="cred( wide)?">/g)].map((m) => m[1] === undefined ? "half" : "whole");
    expect(rows(fixture("plumber-austin"))).toEqual(["half", "half", "half", "half"]);
    const plumber = loadFixture("plumber-austin");
    const two = withFacts(plumber, { licences: [...(plumber.facts.licences ?? []), { label: "Texas backflow tester", number: "BPAT-0081122" }] });
    expect(rows(modern(two))).toEqual(["whole", "whole", "half", "half", "half"]);
    const long = withFacts(plumber, { licences: [{ label: "Texas master plumber", number: "M-40123-2026-AUSTIN" }] });
    expect(rows(modern(long))).toEqual(["whole", "half", "half", "half"]);
    // ...and those heroes take the shorter photo strip on short phones (styles/sheets/modern.css); two short
    // licenses count too
    const twoShort = withFacts(plumber, { licences: [{ label: "Texas master plumber", number: "M-1" }, { label: "Backflow", number: "B-2" }] });
    expect([fixture("plumber-austin"), modern(two), modern(long), modern(twoShort)].map((page) => hero(page).includes("hero--dense"))).toEqual([false, true, true, true]);
  });

  it("show two licenses in the hero and link to the footer, which lists them all, with a label that says so and a down arrow", () => {
    const page = fixture("roofing-extreme");
    const top = hero(page);
    expect(top.match(/License RCAT/g)).toHaveLength(2);
    expect(top).toMatch(/<a href="#licenses">See all 5 licenses<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path [^>]*d="M12 5l0 14M18 13l-6 6M6 13l6 6"\/><\/svg><\/a>/);
    const footer = element(page, "<footer");
    expect(footer).toContain('id="licenses"');
    expect(footer.match(/License RCAT/g)).toHaveLength(5);
  });

  it("each carry their own icon: a certificate, a shield, a calendar for the year and a circled check for free estimates", () => {
    const items = [...hero(fixture("plumber-austin")).matchAll(/<li class="cred[^"]*"><svg[^>]*>([\s\S]*?)<\/svg><span><strong>([^<]*)/g)].map((m) => [m[2], m[1]]);
    expect(items.map(([text]) => text)).toEqual(["License ", "Insured", "Since 1998", "Free estimates"]);
    const icons = items.map(([, svg]) => svg);
    expect(new Set(icons).size).toBe(4);
    expect(icons[2]).toContain("M16 3v4M8 3v4M4 11h16");
    expect(icons[3]).toContain('d="m9 12l2 2l4-4"');
  });

  it("keep a license number of up to 20 characters in one piece, and let a longer one break anywhere", () => {
    expect(fixture("plumber-austin")).toContain('License <span class="whitespace-nowrap">M-40123</span>');
    expect(element(fixture("plumber-austin"), "<footer")).toContain('License <span class="whitespace-nowrap">M-40123</span>');
    expect(fixture("hvac-phoenix")).toContain('License <span class="whitespace-nowrap">ROC 999001</span>');
    expect(fixture("roofing-extreme")).not.toContain('<span class="whitespace-nowrap">RCAT');
  });

  it("never leave the hero's credentials empty: 24/7 service stands in when it is the owner's only trust fact", () => {
    const plumber = loadFixture("plumber-austin");
    const only247 = withFacts(
      { ...plumber, copy: { ...plumber.copy, ctaText: "Get a quote", heroSubheadline: "Clear prices and tidy work, start to finish.", faq: [] } },
      { licences: [], insured: false, yearFounded: undefined, freeEstimates: false, emergency247: true },
    );
    const list = element(hero(modern(only247)), '<ul class="proof-list"');
    expect(list).toContain("24/7 emergency service");
    expect(problems(only247)).toEqual([]);
  });
});

// review1 I-1: Modern writes its own credential words (the hero, the trust band and the footer), so each one must
// leave the page when its fact is off, and nothing it says may pass the shared honesty rule unbacked.
describe("Modern: each credential shows only with its owner fact", () => {
  const OFF: ReadonlyArray<readonly [string, Partial<SiteDocumentInput["facts"]>, RegExp]> = [
    ["not insured", { insured: false }, /Insured/],
    ["no founding year", { yearFounded: undefined }, /\bSince\b/],
    ["no free estimates", { freeEstimates: false }, /Free estimates/],
    ["no 24/7 service", { emergency247: false }, /24\/7/],
    ["no license", { licences: [] }, /License\b/],
  ];
  const PLACES = [
    ["in the hero (trust follows the hero)", "plumber-austin"],
    ["in the band and the hero's line (trust after services)", "hvac-phoenix"],
    ["on a page without a hero photo", "no-photo"],
  ] as const;
  const input = (name: string) => (name === "no-photo" ? withoutHeroPhoto(loadFixture("plumber-austin")) : loadFixture(name as FixtureName));
  // Copy that claims nothing, so the schema accepts every fact turned off (it refuses copy the facts do not back).
  const neutral = (doc: SiteDocumentInput): SiteDocumentInput => ({
    ...doc,
    copy: { ...doc.copy, ctaText: "Get a quote", heroSubheadline: "Clear prices and tidy work, start to finish.", faq: [] },
  });

  it.each(PLACES.flatMap(([where, name]) => OFF.map(([fact, facts, words]) => [where, fact, name, facts, words] as const)))(
    "%s: %s",
    (_where, _fact, name, facts, words) => {
      const doc = withFacts(neutral(input(name)), facts);
      // The owner's own words (reviews, FAQ answers) never hold these exact forms in the fixtures; the page's one
      // comment (the licence attribution, "MIT License") is not page text.
      expect(modern(doc).replace(DESIGNS.modern.attribution, "")).not.toMatch(words);
      expect(problems(doc)).toEqual([]);
    },
  );

  it("with every fact on, each credential shows (so the checks above see the real thing)", () => {
    for (const [, name] of PLACES) {
      const page = modern(withFacts(input(name), { insured: true, yearFounded: 1998, freeEstimates: true, emergency247: true }));
      for (const [, , words] of OFF) expect(page).toMatch(words);
    }
  });
});

describe("Modern: a hero without a photo", () => {
  const noPhoto = withoutHeroPhoto(loadFixture("plumber-austin"));

  it("shows the opening hours in its card, and the service area section shows the places only", () => {
    const page = modern(noPhoto);
    expect(hero(page)).toContain("Office hours");
    expect(hero(page).replace(/<[^>]*>/g, "")).toContain("7:30 AM – 6:00 PM");
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

  it("without hours, its card says where the business works and how to write to it (judges' must-fix)", () => {
    const top = hero(fixture("cleaning-minimal"));
    const card = element(top, '<div class="door"').replace(/<[^>]*>/g, "");
    expect(card).toBe("Service areaBoise, IDEmailhi@mop.example.com");
    expect(top).toContain('href="mailto:hi@mop.example.com"');
    // The owner hid the service area: the card keeps the email only.
    expect(element(hero(modern(withHidden(loadFixture("cleaning-minimal"), ["serviceArea"]))), '<div class="door"').replace(/<[^>]*>/g, "")).toBe("Emailhi@mop.example.com");
    // A photo hero has no card; a no-photo hero with hours shows the hours instead.
    expect(hero(fixture("plumber-austin"))).not.toContain('class="door"');
    expect(hero(modern(noPhoto))).not.toContain("hi@");
  });

  it("a service area of one or two places is a slim band, not a full section", () => {
    expect(fixture("cleaning-minimal")).toContain('<section id="service-area" class="sec slim white"');
    expect(fixture("plumber-austin")).not.toContain("slim");
  });
});

describe("Modern: services are priced cards", () => {
  it("say 'Price on request' only where another service has a price, always under the service's name", () => {
    expect(fixture("plumber-austin").match(/<\/h3><p class="price price--ask">Price on request<\/p>/g)).toHaveLength(2);
    expect(fixture("plumber-austin").match(/<\/h3><p class="price"><small>From<\/small>/g)).toHaveLength(3);
    expect(fixture("cleaning-minimal")).not.toContain("Price on request");
    expect(fixture("cleaning-minimal")).toContain("Ask us for a price.");
  });

  it("end with the call-to-action card, which fills the grid's last row (judges' must-fix: no empty cell)", () => {
    const services = element(fixture("plumber-austin"), '<section id="services"');
    expect(services).toContain('class="cards cards--c3"');
    const cards = element(services, '<ul class="cards');
    expect(cards).toMatch(/<li class="card ask on-brand"><div><p class="ask-q">Not sure which service you need\?<\/p><p>Tell us about the job\.<\/p><\/div><a class="button button-act" href="#contact-form">Get a free quote<\/a><\/li>\n<\/ul>$/);
    expect(services.split('href="#contact-form"')).toHaveLength(2);
    expect(fixture("hvac-phoenix")).toContain('class="cards cards--c4 cards--compact"');
    expect(fixture("cleaning-minimal")).toContain('class="cards cards--c3"');
  });
});

// review1 M3: owner content that only the goldens used to pin.
describe("Modern: shows the owner's content where a visitor looks for it", () => {
  const facts = loadFixture("plumber-austin").facts;
  const page = fixture("plumber-austin");

  it("every photo's alt text and caption, every reviewer's name and town, the email in full", () => {
    for (const photo of facts.photos ?? []) {
      expect(page).toContain(`alt="${photo.alt}"`);
      if (photo.caption !== undefined) expect(page).toContain(`<figcaption>${photo.caption}</figcaption>`);
    }
    for (const review of facts.testimonials ?? []) {
      expect(page).toContain(`<strong>${review.name}</strong>`);
      if (review.location !== undefined) expect(page).toContain(`<span>${review.location}</span>`);
    }
    const shown = (markup: string) => markup.replace(/<wbr>/g, "");
    expect(shown(element(page, '<div class="call-card"'))).toContain(`>${facts.email}</a>`);
    expect(shown(element(page, "<footer"))).toContain(`>${facts.email}</a>`);
    expect(element(page, "<footer")).toContain("<li>Insured</li>");
  });

  it("the call bar's and About's quote buttons lead to the form", () => {
    expect(element(page, "<aside")).toContain('<a class="button button-line" href="#contact-form">');
    expect(element(page, '<section id="about"')).toContain('<a class="button button-line " href="#contact-form">Get a free quote</a>');
  });

  it("one or two places name the home town with its state", () => {
    expect(element(fixture("cleaning-minimal"), '<section id="service-area"')).toContain("Serving <strong>Boise, ID</strong>");
  });
});

describe("Modern: small pieces the judges and the text-spacing check asked for", () => {
  it("the office address carries the building icon", () => {
    const addr = element(element(fixture("plumber-austin"), '<section id="service-area"'), '<div class="addr"');
    expect(addr).toMatch(/^<div class="addr"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path [^>]*d="M3 21l18 0M9 8l1 0/);
    expect(addr).toContain("<address>4100 S Congress Ave<br>Austin, TX 78745</address>");
  });

  it("the footer ends on a closing row with the business name and a way back to the top", () => {
    const footer = element(fixture("plumber-austin"), "<footer");
    expect(footer).toMatch(/<div class="wrap"><div class="foot-end"><p>Reliable Rooter Plumbing<\/p><a href="#top">Back to top<\/a><\/div><\/div>\n<\/footer>$/);
  });

  it("each time in the hours keeps its own words together, so a squeezed column wraps only after the dash", () => {
    expect(fixture("plumber-austin")).toContain('<td class="time"><span class="whitespace-nowrap">7:30 AM –</span> <span class="whitespace-nowrap">6:00 PM</span></td>');
    expect(fixture("plumber-austin")).toContain('<td class="time closed">Closed</td>');
  });

  it("the call card's number may wrap at its space, never inside a part", () => {
    const card = element(fixture("plumber-austin"), '<div class="call-card"');
    expect(card).toContain('<a class="big whitespace-nowrap" href="tel:+15125550142">');
    expect(card).toContain('<span class="whitespace-nowrap">(512)</span> <span class="whitespace-nowrap">555-0142</span>');
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
