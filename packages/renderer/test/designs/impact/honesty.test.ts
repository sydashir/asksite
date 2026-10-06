import { SiteDocument, type SectionId, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { FIXTURE_FORM_ACTION, FIXTURE_SITE_URL, inDesign, loadFixture, stubStylesheets, type FixtureName } from "../../../../../fixtures/index.ts";
import { BASELINE } from "../../../src/baseline.ts";
import { DESIGNS } from "../../../src/designs/index.ts";
import { render, renderDocument } from "../../../src/render.ts";
import { invariantProblems } from "../../support/design-invariants.ts";
import { readableTexts } from "../../support/page-text.ts";

// Bold writes "Licensed", "License", "Insured", "24/7 emergency service" and "Since <year>" itself: in the hero's
// credentials (its card, or its compact line when the section sits further down Home), the credentials band (drawn
// when that section is not straight under the hero), the About numeral, the header, the contact band, the closing
// band and the footer, on whichever page each sits (A16). Each must follow the owner's fact (review2 I-1).
// plumber-austin draws its credentials in the hero; hvac-phoenix, with the owner's order putting the reviews before
// the credentials (U1), draws them as the band and the hero's line. Each is checked with and without photos, with one
// fact off at a time and with all four off. The owner's own words here hold none of these claims once the FAQ's
// "day or night" answer goes with 24/7 service and "licensed" with the licences, so any the site states is Bold's own.

const OPTIONS = { stylesheets: stubStylesheets(), formAction: FIXTURE_FORM_ACTION, siteUrl: FIXTURE_SITE_URL };

type Fact = "licences" | "insured" | "emergency247" | "yearFounded";

/** The words a fact lets Bold write, and nothing else on these pages holds. */
const WORDS: Readonly<Record<Fact, RegExp>> = {
  licences: /licen[cs]/i,
  insured: /insur/i,
  emergency247: /24\/7|emergenc|day or night/i,
  // Case-sensitive: a review on plumber-austin says "perfect since.", in the owner's customer's words.
  yearFounded: /\bSince\b|In business|undefined/,
};

function withoutPhotos(input: SiteDocumentInput): SiteDocumentInput {
  const { heroPhoto: _photo, ...facts } = input.facts;
  return { ...input, facts: { ...facts, photos: [] } };
}

/** The owner's order with `id` moved to straight after `after` (owners reorder sections within a page, U1). */
function moved(input: SiteDocumentInput, id: SectionId, after: SectionId): SiteDocumentInput {
  const rest = input.layout.filter((s) => s.id !== id);
  const section = input.layout.find((s) => s.id === id);
  if (section === undefined) throw new Error(`no ${id} in the layout`);
  const at = rest.findIndex((s) => s.id === after) + 1;
  return { ...input, layout: [...rest.slice(0, at), section, ...rest.slice(at)] } as SiteDocumentInput;
}

/** `value` with every "licensed" (and the like) as "local": only a licensed owner may say it (NEEDS_A_FACT). */
const unlicensed = <T>(value: T): T => JSON.parse(JSON.stringify(value).replace(/\blicen[cs]\w*/gi, "local")) as T;

function without(input: SiteDocumentInput, off: readonly Fact[]): SiteDocumentInput {
  const { yearFounded: year, ...facts } = input.facts;
  const copy = off.includes("licences") ? unlicensed(input.copy) : input.copy;
  return {
    ...input,
    facts: {
      ...facts,
      ...(off.includes("yearFounded") || year === undefined ? {} : { yearFounded: year }),
      ...(off.includes("licences") ? { licences: [], testimonials: unlicensed(facts.testimonials) } : {}),
      ...(off.includes("insured") ? { insured: false } : {}),
      ...(off.includes("emergency247") ? { emergency247: false } : {}),
    },
    // Only a 24/7 owner may promise help "day or night" (NEEDS_A_FACT), so that answer goes with the fact.
    copy: off.includes("emergency247") ? { ...copy, faq: (copy.faq ?? []).filter((q) => !WORDS.emergency247.test(`${q.question} ${q.answer}`)) } : copy,
  };
}

const BASE_DOCS: ReadonlyArray<readonly [FixtureName, SiteDocumentInput]> = [
  ["plumber-austin", inDesign(loadFixture("plumber-austin"), "impact")],
  ["hvac-phoenix", moved(inDesign(loadFixture("hvac-phoenix"), "impact"), "trust", "testimonials")],
];

const bases = BASE_DOCS.flatMap(([name, input]) => [
  [name, input],
  [`${name} without photos`, withoutPhotos(input)],
] as const);

const OFF_SETS: readonly (readonly Fact[])[] = [["licences"], ["insured"], ["emergency247"], ["yearFounded"], ["licences", "insured", "emergency247", "yearFounded"]];

const cases = bases.flatMap(([name, input]) => OFF_SETS.map((off) => [`${name}, ${off.join(" + ")} off`, input, off] as const));

/** The Bold site and today's site for the same document, and the texts every Bold page shows. */
function sites(input: SiteDocumentInput) {
  const doc = SiteDocument.parse(input);
  const site = render(doc, OPTIONS);
  return { doc, site, baseline: renderDocument(doc, BASELINE, OPTIONS), text: site.pages.flatMap((p) => readableTexts(p.html)).join("\n") };
}

const homeOf = (input: SiteDocumentInput) => sites(input).site.pages[0]?.html ?? "";
const band = (page: string) => page.slice(page.indexOf('<section id="credentials" class="sec'), page.indexOf("</section>", page.indexOf('<section id="credentials" class="sec')));

describe("Bold states no credential the owner does not have", () => {
  it("reaches every place Bold writes these words while the owner has the facts", () => {
    for (const [, input] of bases) {
      const { text } = sites(input);
      for (const words of Object.values(WORDS).slice(0, 3)) expect(text).toMatch(words);
      expect(text).toMatch(/\bSince\b/);
    }
    // hvac-phoenix's credentials follow its reviews, so they are the band (24/7 stays in the hero's chip) and the
    // hero's compact line; its footer repeats Insured on every page.
    const hvac = homeOf(BASE_DOCS[1]![1]);
    expect(readableTexts(band(hvac)).join("\n")).toMatch(/Insured[^]*Since 2011/);
    expect(readableTexts(hvac.slice(0, hvac.indexOf('<section id="reviews"'))).join("\n")).toMatch(/Licensed[^]*Insured[^]*Since 2011/);
    expect(readableTexts(hvac.slice(hvac.indexOf("<footer"))).join("\n")).toContain("Insured");
  });

  it.each(cases)("%s: keeps the shared honesty rule and drops the fact's words on every page", (_, input, off) => {
    const { doc, site, baseline, text } = sites(without(input, off));
    expect(invariantProblems(site, baseline, doc, DESIGNS.impact)).toEqual([]);
    for (const fact of off) expect(text).not.toMatch(WORDS[fact]);
  });
});
