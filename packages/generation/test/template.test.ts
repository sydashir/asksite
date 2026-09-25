import { AiDraft, Brief, GOALS, TONES } from "@asksite/core";
import { Facts, SiteDocument, TRADES, unbackedClaims, proseIn } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { render } from "@asksite/renderer";
import { HtmlValidate, StaticConfigLoader } from "html-validate";
import { FIXTURE_FORM_ACTION, FIXTURES, loadFixture } from "../../../fixtures/index.ts";
import { templateDraft } from "../src/template.ts";
import { MINIMAL_FACTS } from "./support/samples.ts";

const issuesOf = (facts: Facts, brief: Brief) => {
  const result = SiteDocument.safeParse({ facts, ...templateDraft(facts, brief), hidden: [] });
  return result.success ? [] : result.error.issues;
};

// Service names that are hard for copy: digits, a 40-character word, JavaScript prototype keys.
const ODD_NAMES = ["24/7 Drain & Sewer", "A".repeat(40), "constructor", "__proto__", "Leak repair", "Toilets", "Water heaters", "Gas lines", "Sump pumps", "Repipes", "Faucets", "Disposals"];

/** Every combination of the facts and brief fields templateDraft reads. */
function* matrix(): Generator<[string, Facts, Brief]> {
  let n = 0;
  for (const trade of TRADES)
    for (let flags = 0; flags < 16; flags++)
      for (const goal of GOALS)
        for (const tone of TONES) {
          n++;
          const services = ODD_NAMES.slice(0, (n % 12) + 1).map((name) => ({ name }));
          const facts = Facts.parse({
            ...MINIMAL_FACTS,
            trade,
            services,
            licences: flags & 1 ? [{ label: "State licence", number: "L-1" }] : [],
            insured: Boolean(flags & 2),
            emergency247: Boolean(flags & 4),
            freeEstimates: Boolean(flags & 8),
            yearFounded: n % 2 ? 1998 : undefined,
            heroPhoto: n % 3 ? undefined : { url: "https://media.example.com/a/h.webp", alt: "Van", width: 1600, height: 900 },
            photos: n % 4 ? [] : [{ url: "https://media.example.com/a/p.webp", alt: "Job", width: 1200, height: 900 }],
            testimonials: n % 5 ? [] : [{ quote: "Great", name: "Ann" }],
          });
          yield [`${trade}/${flags}/${goal}/${tone}/${services.length}`, facts, Brief.parse({ tone, goal })];
        }
}

/** The fallback for `trade` with all twelve ODD_NAMES, so every service description shows. */
const draftFor = (trade: Facts["trade"], goal: Brief["goal"] = "quote", freeEstimates = false): AiDraft =>
  templateDraft(Facts.parse({ ...MINIMAL_FACTS, trade, freeEstimates, services: ODD_NAMES.map((name) => ({ name })) }), Brief.parse({ tone: "friendly", goal }));

/** A text's sentences (split on ". ", "! ", "? " and the end), lowercased, without their closing mark. */
const sentencesOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[.!?](?: |$)/)
    .filter((sentence) => sentence !== "");

/**
 * A text's words: lowercased, split on whitespace, every punctuation mark turned into a space except an
 * apostrophe inside a word, so "we'll" is one word and "tune-up" is two.
 */
const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/(?<!\p{L})'|'(?!\p{L})|[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word !== "");

/** Every run of `n` consecutive words of a text, each joined with single spaces. */
const runsOf = (text: string, n: number): string[] => {
  const words = wordsOf(text);
  return words.slice(0, Math.max(words.length - n + 1, 0)).map((_, i) => words.slice(i, i + n).join(" "));
};

/** British spellings and idioms that read oddly on a US business's page. */
const NOT_US_ENGLISH = ["sort it out", "afterwards", "talk you through", "whilst", "colour", "neighbour"];

/** Promises the fallback must not make (P3-2): it cannot know whether the owner keeps them. */
const PROMISE_WORDS = ["fast", "on time", "tidy", "spotless", "best", "trusted", "affordable", "quality work", "clean up", "done right"];

describe("templateDraft", () => {
  it.each(FIXTURES)("makes a valid document with the facts of fixture %s", (name) => {
    const facts = Facts.parse(loadFixture(name).facts);
    for (const goal of GOALS) expect(issuesOf(facts, Brief.parse({ tone: "friendly", goal }))).toEqual([]);
  });

  it.each(FIXTURES)("renders valid HTML with the facts of fixture %s (Plan 1 renderer, html-validate)", async (name) => {
    const facts = Facts.parse(loadFixture(name).facts);
    const html = render({ facts, ...templateDraft(facts, Brief.parse({ tone: "friendly", goal: "quote" })), hidden: [] }, { stylesheet: "/* css */", formAction: FIXTURE_FORM_ACTION });
    const validator = new HtmlValidate(new StaticConfigLoader({ extends: ["html-validate:recommended"], rules: { "tel-non-breaking": ["error", { ignoreClasses: ["whitespace-nowrap"] }] } }));
    expect((await validator.validateString(html)).valid).toBe(true);
  });

  it("makes a valid document for every trade, claim flag, goal, tone and 1 to 12 services (864 cases)", () => {
    const failures: string[] = [];
    let cases = 0;
    for (const [label, facts, brief] of matrix()) {
      cases++;
      if (issuesOf(facts, brief).length > 0) failures.push(label);
    }
    expect(cases).toBe(864);
    expect(failures).toEqual([]);
  });

  it("offers free only on the quote button and writes no FAQ, across the 864-case matrix (Decision 8)", () => {
    const failures: string[] = [];
    let freeButNotQuote = 0;
    for (const [label, facts, brief] of matrix()) {
      const { copy } = templateDraft(facts, brief);
      if (facts.freeEstimates && brief.goal !== "quote") freeButNotQuote++;
      if (brief.goal !== "quote" && /free/i.test(copy.ctaText)) failures.push(`${label}: ctaText "${copy.ctaText}"`);
      if (JSON.stringify(copy.faq) !== "[]") failures.push(`${label}: faq ${JSON.stringify(copy.faq)}`);
    }
    // The book and call cases where the owner does give free estimates, so "free" would pass the claim checker.
    expect(freeButNotQuote).toBe(288);
    expect(failures).toEqual([]);
  });

  it("never states a claim, even when every flag is set (it cannot know the owner wants one)", () => {
    const facts = Facts.parse({ ...MINIMAL_FACTS, licences: [{ label: "L", number: "1" }], insured: true, emergency247: true });
    const draft = templateDraft(facts, Brief.parse({ tone: "friendly", goal: "call" }));
    for (const [, text] of proseIn(draft.copy)) expect(unbackedClaims(text, MINIMAL_FACTS)).toEqual([]);
  });

  it("says free only when the owner gives free estimates", () => {
    const quote = Brief.parse({ tone: "friendly", goal: "quote" });
    expect(templateDraft({ ...MINIMAL_FACTS, freeEstimates: true }, quote).copy.ctaText).toBe("Get a free quote");
    expect(templateDraft(MINIMAL_FACTS, quote).copy.ctaText).toBe("Request a quote");
  });

  it("never puts owner text in the copy", () => {
    const facts = { ...MINIMAL_FACTS, businessName: "Zqxj Plumbing", location: { city: "Qwvz", state: "TX" } };
    const draft = templateDraft(facts, Brief.parse({ tone: "friendly", goal: "book" }));
    expect(proseIn(draft.copy).map(([, text]) => text).join(" ")).not.toMatch(/Zqxj|Qwvz/);
  });

  it("describes each service by name, in facts order", () => {
    const facts = { ...MINIMAL_FACTS, services: [{ name: "B" }, { name: "A" }] };
    expect(templateDraft(facts, Brief.parse({ tone: "friendly", goal: "call" })).copy.serviceDescriptions.map((d) => d.service)).toEqual(["B", "A"]);
  });

  it("is deterministic and already in parsed form", () => {
    const brief = Brief.parse({ tone: "friendly", goal: "quote" });
    const draft = templateDraft(MINIMAL_FACTS, brief);
    expect(templateDraft(MINIMAL_FACTS, brief)).toEqual(draft);
    expect(AiDraft.parse(draft)).toEqual(draft);
  });

  it("gives each trade three service descriptions of its own", () => {
    const own = new Map(TRADES.map((trade) => [trade, new Set(draftFor(trade).copy.serviceDescriptions.map((d) => d.description))]));
    for (const [trade, descriptions] of own) {
      expect({ trade, distinct: descriptions.size }).toEqual({ trade, distinct: 3 });
      const shared = TRADES.filter((other) => other !== trade).flatMap((other) => [...descriptions].filter((d) => own.get(other)!.has(d)));
      expect({ trade, shared }).toEqual({ trade, shared: [] });
    }
  });

  it("never repeats the headline, subheadline or about text in a service description", () => {
    const repeats: string[] = [];
    for (const trade of TRADES) {
      const { copy } = draftFor(trade);
      const page = [copy.heroHeadline, copy.heroSubheadline, copy.about ?? ""].flatMap(sentencesOf);
      for (const description of new Set(copy.serviceDescriptions.map((d) => d.description))) {
        const text = description.toLowerCase();
        const bare = text.replace(/[.!?]$/, "");
        // Contains a page sentence (or equals one), or is contained in one.
        for (const sentence of page) if (text.includes(sentence) || sentence.includes(bare)) repeats.push(`${trade}: "${description}" repeats "${sentence}"`);
      }
    }
    expect(repeats).toEqual([]);
  });

  it("never reuses a 4-word phrase of the subheadline or about text in a service description", () => {
    const shared: string[] = [];
    for (const trade of TRADES) {
      const { copy } = draftFor(trade);
      const page = new Set([copy.heroSubheadline, copy.about ?? ""].flatMap((text) => runsOf(text, 4)));
      for (const description of new Set(copy.serviceDescriptions.map((d) => d.description)))
        for (const run of runsOf(description, 4)) if (page.has(run)) shared.push(`${trade}: "${run}" in "${description}"`);
    }
    expect(shared).toEqual([]);
  });

  it("uses the approved section intros and tuned descriptions (P3-2c)", () => {
    for (const trade of TRADES) {
      const { services, contact } = draftFor(trade).copy.sectionIntros;
      expect({ trade, services, contact }).toEqual({ trade, services: "Here's what we can help with.", contact: "Send us a few details and we'll get back to you." });
    }
    expect(draftFor("hvac").copy.serviceDescriptions[0]?.description).toBe("Tell us about your home's heating or cooling and what you'd like done.");
    expect(draftFor("landscaping").copy.serviceDescriptions[1]?.description).toBe("Questions about this service? Ask us and we'll talk it over.");
  });

  it("uses plain US English", () => {
    const found: string[] = [];
    for (const trade of TRADES)
      for (const goal of GOALS) {
        const prose = proseIn(draftFor(trade, goal).copy)
          .map(([, text]) => text)
          .join(" ")
          .toLowerCase();
        for (const phrase of NOT_US_ENGLISH) if (prose.includes(phrase)) found.push(`${trade}/${goal}: ${phrase}`);
      }
    expect(found).toEqual([]);
  });

  it("promises nothing and uses only straight apostrophes, for every trade, goal and free-estimate setting", () => {
    const found: string[] = [];
    for (const trade of TRADES)
      for (const goal of GOALS)
        for (const freeEstimates of [false, true]) {
          const prose = proseIn(draftFor(trade, goal, freeEstimates).copy)
            .map(([, text]) => text)
            .join(" ");
          for (const phrase of PROMISE_WORDS) if (new RegExp(`\\b${phrase}\\b`).test(prose.toLowerCase())) found.push(`${trade}/${goal}/${freeEstimates}: ${phrase}`);
          if (/[\u2018\u2019]/.test(prose)) found.push(`${trade}/${goal}/${freeEstimates}: curly apostrophe`);
        }
    expect(found).toEqual([]);
  });
});
