import { SiteDocument, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { FIXTURE_FORM_ACTION, inDesign, loadFixture, stubStylesheets, type FixtureName } from "../../../../../fixtures/index.ts";
import { BASELINE } from "../../../src/baseline.ts";
import { DESIGNS } from "../../../src/designs/index.ts";
import { render, renderDocument } from "../../../src/render.ts";
import { invariantProblems } from "../../support/design-invariants.ts";
import { readableTexts } from "../../support/page-text.ts";

// Bold writes "Insured", "24/7 emergency service" and "Since <year>" itself: in the hero's credentials, the
// credentials band (drawn when that section is not straight under the hero), the About numeral, the header, the
// contact band and the footer. Each must follow the owner's fact (review2 I-1). plumber-austin draws its
// credentials in the hero and hvac-phoenix as the band; each is checked with and without photos, with one fact
// off at a time and with all three off. The owner's own words here hold none of these claims once the FAQ's
// "day or night" answer goes with 24/7 service, so any the page states is Bold's own.

const OPTIONS = { stylesheets: stubStylesheets(), formAction: FIXTURE_FORM_ACTION };

type Fact = "insured" | "emergency247" | "yearFounded";

/** The words a fact lets Bold write, and nothing else on these pages holds. */
const WORDS: Readonly<Record<Fact, RegExp>> = {
  insured: /insur/i,
  emergency247: /24\/7|emergenc|day or night/i,
  // Case-sensitive: a review on plumber-austin says "perfect since.", in the owner's customer's words.
  yearFounded: /\bSince\b|In business|undefined/,
};

function withoutPhotos(input: SiteDocumentInput): SiteDocumentInput {
  const { heroPhoto: _photo, ...facts } = input.facts;
  return { ...input, facts: { ...facts, photos: [] } };
}

function without(input: SiteDocumentInput, off: readonly Fact[]): SiteDocumentInput {
  const { yearFounded: year, ...facts } = input.facts;
  return {
    ...input,
    facts: {
      ...facts,
      ...(off.includes("yearFounded") || year === undefined ? {} : { yearFounded: year }),
      ...(off.includes("insured") ? { insured: false } : {}),
      ...(off.includes("emergency247") ? { emergency247: false } : {}),
    },
    // Only a 24/7 owner may promise help "day or night" (NEEDS_A_FACT), so that answer goes with the fact.
    copy: off.includes("emergency247") ? { ...input.copy, faq: (input.copy.faq ?? []).filter((q) => !WORDS.emergency247.test(`${q.question} ${q.answer}`)) } : input.copy,
  };
}

const bases: ReadonlyArray<readonly [string, SiteDocumentInput]> = (["plumber-austin", "hvac-phoenix"] as const satisfies readonly FixtureName[]).flatMap((name) => {
  const input = inDesign(loadFixture(name), "impact");
  return [
    [name, input],
    [`${name} without photos`, withoutPhotos(input)],
  ] as const;
});

const OFF_SETS: readonly (readonly Fact[])[] = [["insured"], ["emergency247"], ["yearFounded"], ["insured", "emergency247", "yearFounded"]];

const cases = bases.flatMap(([name, input]) => OFF_SETS.map((off) => [`${name}, ${off.join(" + ")} off`, input, off] as const));

/** The Bold page and today's page for the same document, and the texts the Bold page shows. */
function pages(input: SiteDocumentInput) {
  const doc = SiteDocument.parse(input);
  const page = render(doc, OPTIONS).html;
  return { doc, page, baseline: renderDocument(doc, BASELINE, OPTIONS).html, text: readableTexts(page).join("\n") };
}

const band = (page: string) => page.slice(page.indexOf('<section id="credentials" class="sec'), page.indexOf("</section>", page.indexOf('<section id="credentials" class="sec')));

describe("Bold states no credential the owner does not have", () => {
  it("reaches every place Bold writes these words while the owner has the facts", () => {
    for (const [, input] of bases) {
      const { text } = pages(input);
      for (const words of Object.values(WORDS).slice(0, 2)) expect(text).toMatch(words);
      expect(text).toMatch(/\bSince\b/);
    }
    // hvac-phoenix's credentials follow its services, so they are the band; its footer repeats Insured.
    const hvac = pages(inDesign(loadFixture("hvac-phoenix"), "impact")).page;
    expect(readableTexts(band(hvac)).join("\n")).toMatch(/Insured[^]*Since 2011[^]*24\/7 emergency service/);
    expect(readableTexts(hvac.slice(hvac.indexOf("<footer"))).join("\n")).toContain("Insured");
  });

  it.each(cases)("%s: keeps the shared honesty rule and drops the fact's words everywhere", (_, input, off) => {
    const { doc, page, baseline, text } = pages(without(input, off));
    expect(invariantProblems(page, baseline, doc, DESIGNS.impact)).toEqual([]);
    for (const fact of off) expect(text).not.toMatch(WORDS[fact]);
  });
});
