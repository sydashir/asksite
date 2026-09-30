import { readFileSync } from "node:fs";
import { FONT_IDS, PALETTE_IDS, SiteDocument, Theme, type SiteDocumentInput } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { FIXTURE_FORM_ACTION, inDesign, loadFixture, stubStylesheets } from "../../../../../fixtures/index.ts";
import { BASELINE } from "../../../src/baseline.ts";
import { contrastRatio, hexToRgb } from "../../../src/contrast.ts";
import { escapeText } from "../../../src/escape.ts";
import { placeColumns } from "../../../src/designs/refined/area.ts";
import { DESIGNS } from "../../../src/designs/index.ts";
import { ctaShort, groupedHours } from "../../../src/designs/refined/parts.ts";
import { heroQuoteIndex } from "../../../src/designs/refined/plan.ts";
import { PALETTES, variables } from "../../../src/designs/refined/tokens.ts";
import { render, renderDocument } from "../../../src/render.ts";
import { invariantProblems } from "../../support/design-invariants.ts";
import { squashedText } from "../../support/page-text.ts";

const OPTIONS = { stylesheets: stubStylesheets(), formAction: FIXTURE_FORM_ACTION };
const page = (input: SiteDocumentInput) => render(inDesign(input, "refined"), OPTIONS).html;
const plumber = loadFixture("plumber-austin");
const hvac = loadFixture("hvac-phoenix");
const cleaning = loadFixture("cleaning-minimal");
const text = (html: string) => squashedText(html.slice(html.indexOf("<body")));
/** The markup of the section with this element id ("" when the page leaves it out). */
const section = (html: string, id: string) => {
  const start = html.indexOf(`<section id="${id}"`);
  return start === -1 ? "" : html.slice(start, html.indexOf("</section>", start));
};

describe("Classic non-text contrast (WCAG 1.4.11 and the look)", () => {
  // [foreground, background, minimum, what it is]
  const NON_TEXT = [
    ["ink", "paper", 3, "focus ring on a light band"],
    ["ink", "surface", 3, "focus ring on a card or the form"],
    ["onDark", "dark", 3, "focus ring on the dark band"],
    ["onDark", "dark2", 3, "focus ring in the footer"],
    ["field", "surface", 3, "form field border"],
    ["rule", "paper", 2, "price-list leader (decorative, must stay visible)"],
    ["rule", "surface", 2, "price-list leader (decorative, must stay visible)"],
    ["accent", "paper", 2.4, "frame lines and diamonds (decorative)"],
    ["accent", "surface", 2.4, "frame lines and diamonds (decorative)"],
    ["action", "dark", 1.8, "the action colour stands apart from the dark band"],
    ["action", "brand", 1.4, "the action colour stands apart from the brand colour"],
  ] as const;
  describe.each(PALETTE_IDS)("%s", (id) => {
    it.each(NON_TEXT)("%s on %s reaches %s:1 (%s)", (fg, bg, min) => {
      expect(contrastRatio(hexToRgb(PALETTES[id][fg]), hexToRgb(PALETTES[id][bg]))).toBeGreaterThanOrEqual(min);
    });
  });
});

describe("Classic tokens", () => {
  const sheet = readFileSync(new URL("../../../styles/sheets/refined.css", import.meta.url), "utf8");
  const read = new Set([...sheet.matchAll(/var\((--aw-refined-[a-z0-9-]+)/g)].map((m) => m[1] ?? ""));

  it.each(PALETTE_IDS.flatMap((palette) => FONT_IDS.map((font) => [palette, font] as const)))(
    "%s with %s lettering sets every property the sheet reads, and nothing it does not",
    (palette, font) => {
      const set = Object.keys(variables(Theme.parse({ palette, font, design: "refined" })));
      expect([...read].filter((name) => !set.includes(name))).toEqual([]);
      expect(set.filter((name) => !read.has(name) && !["--aw-refined-head", "--aw-refined-body"].includes(name))).toEqual([]);
    },
  );

  it("each lettering choice has its own heading face", () => {
    const heads = FONT_IDS.map((font) => variables(Theme.parse({ palette: "navy-orange", font, design: "refined" }))["--aw-refined-head"]);
    expect(new Set(heads).size).toBe(FONT_IDS.length);
  });
});

describe("Classic layout rules", () => {
  it("balances the town columns so no column ends with one town alone", () => {
    expect([1, 2, 3, 6, 7, 30].map((n) => placeColumns(n, 3))).toEqual([1, 2, 3, 3, 2, 3]);
    expect([1, 2, 3, 7].map((n) => placeColumns(n, 2))).toEqual([1, 2, 1, 2]);
  });

  it("groups days that share hours", () => {
    const { hours } = loadFixture("hvac-phoenix").facts;
    expect(groupedHours(hours ?? [])).toEqual([
      { label: "Monday – Friday", time: "7:00 AM – 7:00 PM" },
      { label: "Saturday & Sunday", time: "Open 24 hours" },
    ]);
  });

  it("says free in a short label only with the owner's free-estimates fact", () => {
    // plumber-austin has the free-estimates fact; hvac-phoenix does not (its copy may not say "free").
    const withCta = (input: SiteDocumentInput, ctaText: string) => SiteDocument.parse({ ...input, copy: { ...input.copy, ctaText } });
    const hvac = loadFixture("hvac-phoenix");
    expect(ctaShort(withCta(plumber, "Get a free quote"))).toBe("Free quote");
    expect(ctaShort(withCta(plumber, "Schedule a free estimate"))).toBe("Free estimate");
    expect(ctaShort(withCta(hvac, "Get a quote today"))).toBe("Get a quote");
    expect(ctaShort(withCta(hvac, "Ask us about your system"))).toBe("Get a quote");
    expect(ctaShort(withCta(hvac, "Schedule your service"))).toBe("Book now");
    expect(ctaShort(withCta(hvac, "Book a visit"))).toBe("Book a visit");
    expect(ctaShort(withCta(hvac, "Book"))).toBe("Book a visit");
  });

  it("puts one short review in the hero only while the Reviews section keeps another", () => {
    const review = (quote: string, location?: string) => ({ quote, name: "Pat", ...(location ? { location } : {}) });
    expect(heroQuoteIndex([])).toBe(-1);
    expect(heroQuoteIndex([review("Great work.", "Austin, TX")])).toBe(-1);
    expect(heroQuoteIndex([review("Lead review."), review("Short, with a town.", "Austin, TX")])).toBe(1);
    expect(heroQuoteIndex([review("x".repeat(161)), review("y".repeat(161))])).toBe(-1);
  });
});

describe("Classic pages", () => {
  it("shows every review exactly once", () => {
    for (const name of ["plumber-austin", "hvac-phoenix", "roofing-extreme"] as const) {
      const quotes = [...page(loadFixture(name)).matchAll(/<blockquote><p>([\s\S]*?)<\/p><\/blockquote>/g)].map((m) => m[1]);
      const reviews = (loadFixture(name).facts.testimonials ?? []).map((t) => escapeText(t.quote));
      expect(quotes.toSorted(), name).toEqual(reviews.toSorted());
    }
  });

  it("shows no hours and no towns once the owner hides the Service area section", () => {
    const hvac = loadFixture("hvac-phoenix");
    const shown = text(page(hvac));
    const hidden = text(page({ ...hvac, hidden: ["serviceArea"] }));
    expect(shown).toContain(squashedText("Open 24 hours"));
    expect(shown).toContain("Serving");
    expect(hidden).not.toContain(squashedText("Open 24 hours"));
    expect(hidden).not.toContain("Serving");
    expect(hidden).not.toContain(squashedText("Regular hours"));
  });

  it("keeps license lines out of the hero and contact band once the owner hides the Credentials section", () => {
    const html = page({ ...loadFixture("hvac-phoenix"), hidden: ["trust"] });
    const body = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
    expect(body).not.toContain("ROC 999001");
    expect(html.slice(html.indexOf("<footer"))).toContain("ROC 999001");
  });

  it("offers free estimates only with the owner's fact", () => {
    expect(hvac.facts.freeEstimates).not.toBe(true);
    expect(text(page(plumber))).toContain(squashedText("Free estimates"));
    expect(text(page(hvac))).not.toMatch(/free/i);
  });

  it("says nothing about a founded year the owner did not give", () => {
    const { yearFounded: _year, ...facts } = hvac.facts;
    const shown = text(page({ ...hvac, facts }));
    expect(shown).not.toContain("undefined");
    expect(shown).not.toMatch(/\bsince\b/i);
  });

  it("shows no review anywhere, the hero included, once the owner hides the Reviews section", () => {
    const shown = page({ ...hvac, hidden: ["testimonials"] });
    for (const review of hvac.facts.testimonials ?? []) expect(shown).not.toContain(escapeText(review.quote));
  });
});

// Classic writes "Insured" (credentials, hero ledger and proof line, contact band, footer), "24/7 emergency service"
// and "Free estimates" itself, so each must follow the owner's fact (review1 I-1). The owner's own words here hold none
// of these claims, so any the page states is Classic's own, and the shared honesty rule compares it with today's page.
describe("Classic states no credential the owner does not have", () => {
  const off = { insured: false, emergency247: false, freeEstimates: false };
  const DOCS: ReadonlyArray<readonly [string, SiteDocumentInput]> = [
    [
      "plumber-austin",
      {
        ...plumber,
        facts: { ...plumber.facts, ...off },
        copy: { ...plumber.copy, ctaText: "Request a quote", heroSubheadline: "Drains, pipes and water heaters across the Austin area.", faq: (plumber.copy.faq ?? []).slice(2, 3) },
      },
    ],
    ["hvac-phoenix", { ...hvac, facts: { ...hvac.facts, ...off }, copy: { ...hvac.copy, faq: [] } }],
  ];

  it.each(DOCS)("%s without Insured, 24/7 service or free estimates", (_, input) => {
    const doc = SiteDocument.parse(inDesign(input, "refined"));
    const shown = render(doc, OPTIONS).html;
    expect(invariantProblems(shown, renderDocument(doc, BASELINE, OPTIONS).html, doc, DESIGNS.refined)).toEqual([]);
    // squashedText drops the spaces, so the words are matched without word edges.
    expect(text(shown)).not.toMatch(/insured|24\/7|emergency|free/i);
  });
});

// The approved mockup folds away a Service area section that would only repeat the hero (one town, no area note, no
// hours to show). The shared contract keeps the section and its menu link (A12 §7), so Classic draws it as one line.
describe("a one-town owner's Service area", () => {
  it("is one short line that names the town once, and no booking box sits between the price list and the form", () => {
    const html = page(cleaning);
    const area = section(html, "service-area");
    expect(area).not.toBe("");
    expect(area).not.toContain('class="area"');
    expect(squashedText(area).match(/Boise/g)).toHaveLength(1);
    expect(squashedText(section(html, "services"))).not.toContain(squashedText("Ready to book?"));
    expect(squashedText(section(html, "contact"))).not.toContain("Serving");
  });

  it("names the owner's base too when it is not the town served", () => {
    const area = squashedText(section(page({ ...cleaning, facts: { ...cleaning.facts, serviceArea: { places: ["Meridian"] } } }), "service-area"));
    expect(area).toContain(squashedText("Serving Meridian"));
    expect(area).toContain(squashedText("Based in Boise, ID"));
  });

  it("keeps the full section for two towns, an area note, or hours the hero does not show", () => {
    const withFacts = (facts: Partial<SiteDocumentInput["facts"]>): SiteDocumentInput => ({ ...cleaning, facts: { ...cleaning.facts, ...facts } });
    const hours = [{ days: ["Monday" as const], opens: "08:00", closes: "17:00" }];
    const photo = { url: "https://media.example.com/a.webp", width: 1600, height: 900, alt: "A clean kitchen" };
    for (const facts of [{ serviceArea: { places: ["Boise", "Meridian"] } }, { serviceArea: { places: ["Boise"], note: "All of Ada County" } }, { hours, heroPhoto: photo }]) {
      expect(section(page(withFacts(facts)), "service-area"), JSON.stringify(facts)).toContain('class="area"');
    }
    // The business card lists the hours on the first screen, so they fold too.
    expect(section(page(withFacts({ hours })), "service-area")).not.toContain('class="area"');
    expect(section(page(plumber), "service-area")).toContain('class="area"');
  });
});
