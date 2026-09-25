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
});
