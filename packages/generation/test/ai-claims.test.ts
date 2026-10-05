import { GOALS, TONES } from "@asksite/core";
import { DAYS, Facts, SiteDocument, TRADES } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { FIXTURES, loadFixture } from "../../../fixtures/index.ts";
import { CAPS_SNAPSHOT } from "../eval/caps.ts";
import { aiClaimIssues, aiClaims } from "../src/ai-claims.ts";
import { SYSTEM_PROMPT } from "../src/prompt.ts";
import { templateAnswer } from "../src/template.ts";
import { checkDraft } from "../src/validate.ts";
import { BRIEF, FULL_FACTS, MINIMAL_FACTS, MINIMAL_SNAPSHOT } from "./support/samples.ts";

const brief = MINIMAL_SNAPSHOT.brief;

type Field = "heroHeadline" | "about";

/** The probe's way (Plan 3 claims-paraphrases.md): templateAnswer with one copy field replaced, through checkDraft. */
const probe = (facts: Facts, text: string, field: Field = "heroHeadline") => {
  const answer = templateAnswer(facts, brief);
  return checkDraft(facts, { ...answer, copy: { ...answer.copy, [field]: text } });
};

const issuesOf = (result: ReturnType<typeof checkDraft>) => (result.ok ? [] : result.issues);

/** MINIMAL_FACTS with some facts the owner gave. */
const withFacts = (extra: Record<string, unknown>): Facts => Facts.parse({ ...MINIMAL_FACTS, ...extra });
const LICENSED = withFacts({ licences: [{ label: "Texas cleaner", number: "C-1" }] });
const INSURED = withFacts({ insured: true });
const EMERGENCY = withFacts({ emergency247: true });
const FREE = withFacts({ freeEstimates: true });
const SEVEN_DAYS = withFacts({ hours: [{ days: [...DAYS], opens: "08:00", closes: "17:00" }] });
const SIX_DAYS = withFacts({ hours: [{ days: DAYS.slice(0, 6), opens: "08:00", closes: "17:00" }] });

/** [probe number in claims-paraphrases.md (or what it is), the exact string, the words the message must show, the field]. */
type Case = readonly [id: string, text: string, words: readonly string[], field?: Field];

/** A refused string is refused at its field, in the message style of site-schema's claim issues, naming each word. */
function refused(facts: Facts, cases: readonly Case[]): void {
  it.each(cases.map(([id, text, words, field]) => [id, text, words, field ?? "heroHeadline"] as const))("refuses %s: %s", (_id, text, words, field) => {
    const result = probe(facts, text, field);
    expect(result.ok).toBe(false);
    expect(issuesOf(result)).toEqual([
      { path: ["copy", field], code: "custom", message: `Copy states something the owner's facts do not back: ${words.map((w) => JSON.stringify(w)).join(", ")}` },
    ]);
  });
}

function accepted(facts: Facts, cases: ReadonlyArray<readonly [id: string, text: string]>): void {
  it.each(cases)("accepts %s: %s", (_id, text) => {
    expect(issuesOf(probe(facts, text))).toEqual([]);
    expect(probe(facts, text).ok).toBe(true);
  });
}

describe("AI claim check: the control", () => {
  it("accepts the unmodified template answer", () => {
    expect(checkDraft(MINIMAL_FACTS, templateAnswer(MINIMAL_FACTS, brief)).ok).toBe(true);
  });
});

describe("AI claim check: licence", () => {
  refused(MINIMAL_FACTS, [
    ["#7", "Fully lic. and ins. cleaning crew", ["lic.", "ins."]],
    ["#32", "Background-checked, state-approved cleaners", ["state-approved", "Background-checked"]],
    ["board", "Board-approved cleaners", ["Board-approved"]],
    ["city", "City approved cleaners", ["City approved"]],
    ["county, em dash", "County\u2014approved cleaners", ["County\u2014approved"]],
    ["background checks", "Cleaners with background checks", ["background checks"]],
    ["vetted", "Vetted cleaners for your home", ["Vetted"]],
    ["lic. in the about", "We are lic. in Texas.", ["lic."], "about"],
  ]);
  refused(MINIMAL_FACTS, [
    ["Fully ins.", "Fully ins. crew", ["ins."]],
    ["lic.-ins.", "A lic.-ins. crew", ["lic.", "ins."]],
  ]);
  refused(INSURED, [["lic. needs a licence, not insurance", "Our lic. crew", ["lic."]]]);
  refused(LICENSED, [["state-approved is never backed", "State-approved cleaners", ["State-approved"]]]);
  accepted(LICENSED, [["lic. with a licence fact", "Our lic. crew"]]);
});

describe("AI claim check: insurance", () => {
  refused(MINIMAL_FACTS, [
    ["#8", "Covered by full liability coverage", ["liability"]],
    ["ins.", "Our ins. cleaning crew", ["ins."]],
    ["liabilities", "We carry full liabilities coverage", ["liabilities"]],
  ]);
  refused(EMERGENCY, [["liability needs insurance, not emergency service", "Liability coverage on every job", ["Liability"]]]);
  refused(LICENSED, [["liability needs insurance, not a licence", "Liability coverage for you", ["Liability"]]]);
  accepted(MINIMAL_FACTS, [
    ["check-ins.", "Easy check-ins."],
    ["walk-ins.", "We take walk-ins."],
    ["walk-ins. mid-text", "Walk-ins. are welcome"],
    ["drive-ins.", "Drive-ins. are welcome"],
    ["known gap: Fully-ins.", "Fully-ins. crew"],
    ["known gap: Fully, U+2010, ins.", "Fully\u2010ins. crew"],
  ]);
  accepted(LICENSED, [["known gap: Licensed-and-ins. (licensed is backed by the licence)", "A Licensed-and-ins. crew"]]);
  accepted(INSURED, [
    ["liability with the insured fact", "Covered by full liability coverage"],
    ["ins. with the insured fact", "Our ins. crew"],
    ["liabilities with the insured fact", "We carry full liabilities coverage"],
  ]);
});

describe("AI claim check: availability", () => {
  refused(MINIMAL_FACTS, [
    ["#13", "After-hours cleaning when you need it", ["After-hours"]],
    ["after hours, spaced", "We work after hours too", ["after hours"]],
    ["#14", "Available at all hours, nights and holidays", ["all hours"]],
    ["holidays", "Here on holidays", ["holidays"]],
    ["#15 (known gap)", "Here for you every day", ["every day"]],
    ["#16", "Open daily for your home", ["Open daily"]],
    ["available daily", "Available daily in Austin", ["Available daily"]],
    ["en dash joins", "After\u2013hours cleaning", ["After\u2013hours"]],
    ["minus sign joins", "After\u2212hours cleaning", ["After\u2212hours"]],
  ]);
  refused(SIX_DAYS, [["six days of hours do not back it", "Here for you every day", ["every day"]]]);
  refused(LICENSED, [["a licence does not back it", "Open daily for your home", ["Open daily"]]]);
  accepted(EMERGENCY, [
    ["after-hours with emergency247", "After-hours cleaning when you need it"],
    ["every day with emergency247", "Here for you every day"],
    ["all hours, nights and holidays", "Available at all hours, nights and holidays"],
  ]);
  accepted(SEVEN_DAYS, [
    ["open daily with hours on all 7 days", "Open daily for your home"],
    ["every day with hours on all 7 days", "Here for you every day"],
  ]);
});

describe("AI claim check: response time", () => {
  refused(MINIMAL_FACTS, [
    ["#17", "We arrive within the hour", ["within the hour"]],
    ["within an hour", "We arrive within an hour", ["within an hour"]],
    ["hyphen", "Within-the-hour arrival", ["Within-the-hour"]],
  ]);
  refused(EMERGENCY, [["no fact backs a response time", "We arrive within the hour", ["within the hour"]]]);
});

describe("AI claim check: free", () => {
  refused(INSURED, [
    ["insurance does not back free", "Stress-free cleaning", ["free"]],
    ["insurance does not back zero cost", "Estimates at zero cost to you", ["zero cost"]],
  ]);
  refused(MINIMAL_FACTS, [
    ["#9", "Estimates at zero cost to you", ["zero cost"]],
    ["#10", "Quotes are gratis and on the house", ["gratis"]],
    ["#11", "We never charge for a quote", ["never charge"]],
    ["#12", "Estimates without charge", ["without charge"]],
    ["no fee", "Quotes with no fee", ["no fee"]],
    ["no fees", "Quotes with no fees", ["no fees"]],
    ["stress-free", "Stress-free cleaning", ["free"]],
    ["hassle-free", "Hassle-free visits", ["free"]],
    ["free-standing", "Free-standing shelves", ["Free"]],
  ]);
  accepted(FREE, [
    ["zero cost with freeEstimates", "Estimates at zero cost to you"],
    ["gratis, on the house", "Quotes are gratis and on the house"],
    ["never charge", "We never charge for a quote"],
    ["without charge", "Estimates without charge"],
    ["no fees", "Quotes with no fees"],
    ["stress-free", "Stress-free cleaning"],
    ["free estimates", "Free estimates for every job"],
    ["known gap: free service calls", "Free service calls on every job"],
  ]);
  accepted(MINIMAL_FACTS, [
    ["freedom is not free", "Freedom from clutter"],
    ["freezer", "We clean your freezer"],
    ["FreeFlow in a name", "FreeFlow Cleaning is ready"],
  ]);
});

describe("AI claim check: time in business", () => {
  refused(MINIMAL_FACTS, [
    ["#25", "A longtime local business with seasoned pros", ["longtime"]],
    ["long-time", "A long-time local business", ["long-time"]],
    ["long, figure dash, time", "A long\u2012time local business", ["long\u2012time"]],
    ["long, en dash, time", "A long\u2013time local business", ["long\u2013time"]],
    ["long, em dash, time", "A long\u2014time local business", ["long\u2014time"]],
    ["seasoned alone", "Seasoned pros", ["Seasoned"]],
  ]);
  refused(MINIMAL_FACTS, [["long, minus sign, time", "A long\u2212time local business", ["long\u2212time"]]]);
  accepted(MINIMAL_FACTS, [
    ["lasts a long time", "The finish lasts a long time"],
    ["for a long time", "Your floors stay clean for a long time"],
    ["known gap: a long time local business", "A long time local business"],
    ["known gap: serving for a long time", "Serving Austin for a long time"],
  ]);
  refused(withFacts({ yearFounded: 1998 }), [["yearFounded does not back it", "A longtime local business", ["longtime"]]]);
});

describe("AI claim check: reviews", () => {
  refused(MINIMAL_FACTS, [
    ["#19", "Neighbors rave about our work", ["rave"]],
    ["raves", "Everyone raves about us", ["raves"]],
    ["raved", "Customers raved", ["raved"]],
    ["#21", "Highly recommended by local families", ["recommended"]],
    ["recommended, hyphen", "Highly-recommended crew", ["recommended"]],
  ]);
});

describe("AI claim check: quote marks", () => {
  refused(MINIMAL_FACTS, [
    ["#22 single guillemets", "\u2039Best cleaners ever\u203A Dana", ["\u2039"]],
    ["U+203A alone", "Best cleaners ever\u203A Dana", ["\u203A"]],
    ["#23 straight single quotes", "'Best cleaners ever' Dana", ["'Best cleaners ever'"]],
    ["single quotes after a colon", "Dana: 'Best cleaners ever'", ["'Best cleaners ever'"]],
    ["single quotes after a comma", "As Dana put it,'best cleaners in Austin'", ["'best cleaners in Austin'"]],
    ["single quotes after a semicolon", "As Dana put it;'best cleaners in Austin'", ["'best cleaners in Austin'"]],
    ["single quotes after a comma and a space (the usual copy)", "As Dana put it, 'best cleaners in Austin'", ["'best cleaners in Austin'"]],
    ["single quotes after a semicolon and a space (the usual copy)", "As Dana put it; 'best cleaners in Austin'", ["'best cleaners in Austin'"]],
    ["single quotes opening with a word that only starts like an elision", "'Emma and her crew are the best' Dana", ["'Emma and her crew are the best'"]],
    ["single quotes after an em dash", "Dana\u2014'Best cleaners ever'", ["'Best cleaners ever'"]],
    ["single quotes closing a parenthesis", "Dana ('Best cleaners ever')", ["'Best cleaners ever'"]],
    ["single quotes opening with a parenthesis", "('Best cleaners ever') Dana", ["'Best cleaners ever'"]],
    ["#24 corner double primes", "\u301DBest cleaners ever\u301E", ["\u301D"]],
    ["U+301F", "Best cleaners ever\u301F", ["\u301F"]],
    ["single quotes round a phrase with a contraction", "Our crew: 'don't wait for it' to us", ["'don't wait for it'"]],
  ]);
  accepted(MINIMAL_FACTS, [
    ["apostrophe: don't", "Don't wait, call us"],
    ["apostrophe: owner's", "Ask the owner's crew about it"],
    ["apostrophe: Mop's", "Mop's crew cleans your home"],
    ["plural possessive", "Cleaning for the owners' and tenants' homes"],
    ["rock 'n' roll", "Rock 'n' roll radio while we work"],
    ["an opening ' that no closing ' answers", "Call 'em, they're the owner's pick"],
    ["rock 'N' roll", "Rock 'N' roll radio while we work, the owners' pick"],
    ["'em then a closing '", "Give 'em a call, our pros' work speaks"],
    ["'til then a closing '", "Open 'til the job is done, the owners' homes"],
    ["'cause, 'bout, 'round", "We call 'cause we care, talk 'bout it, 'round the corner from the owners' homes"],
    ["'tis, 'twas", "'Tis the season, 'twas the owners' idea"],
    ["an elision after a parenthesis", "Call us ('til late), the owners' homes"],
    ["known gap: a quotation starting 'Tis", "'Tis the best crew ever' Dana"],
    ["known gap: a quotation starting 'Em", "'Em pros are the best' Dana"],
    ["known gap: a quotation starting 'Cause", "'Cause they care' Dana"],
    ["known gap: a quotation starting 'Tis, after a colon", "Dana: 'Tis the best crew ever'"],
    ["known gap: a quotation starting 'Tis, in parentheses", "Dana ('Tis the best crew ever')"],
    ["known gap: a quotation starting 'N'", "'N' they are the best' Dana"],
    ["code-like text", "Not a quote: f('alert')"],
  ]);
});

/** Wording the site-schema checker already refuses at main: the AI check never sees it, and these stay refused. */
describe("AI claim check: already refused by the site-schema checker", () => {
  it.each([
    ["rave reviews", "Rave reviews all round"],
    ["free-standing", "Free-standing shelves"],
    ["a look-alike f", "Cleaning that is \u0192ree of mess"],
    ["quoted said", "He said 'don't wait for it' to us"],
  ])("refuses %s: %s", (_id, text) => {
    expect(probe(MINIMAL_FACTS, text).ok).toBe(false);
  });
});

describe("AI claim check: allowed wording", () => {
  accepted(MINIMAL_FACTS, [
    ["we recommend", "We recommend a deep clean before you move in"],
    ["daily cleaning", "Daily cleaning for busy offices"],
    ["coverage area", "Our coverage area is all of Austin"],
    ["covered", "Every room is covered"],
    ["ctaText example", "Request a quote"],
    ["page pointer", "See our Contact page"],
  ]);
});

describe("aiClaims: readings and quote marks", () => {
  it("refuses U+FF02, which Copy's NFKC turns into a straight double quote before checkDraft sees it", () => {
    expect(aiClaims("\uFF02Best cleaners ever\uFF02", MINIMAL_FACTS)).toEqual(["\uFF02"]);
  });

  it.each([
    ["a non-breaking hyphen", "After\u2011hours cleaning", "After-hours"],
    ["a dotless i", "Our l\u0131c. crew", "lic."],
    ["a combining mark inside the word", "Vet\u0336ted cleaners", "Vetted"],
    ["a figure dash", "Within\u2012the\u2012hour arrival", "Within\u2012the\u2012hour"],
  ])("reads %s as claims.ts does", (_why, text, word) => {
    expect(aiClaims(text, MINIMAL_FACTS)).toEqual([word]);
  });

  it("allows no claim in empty or plain text", () => {
    expect(aiClaims("", MINIMAL_FACTS)).toEqual([]);
    expect(aiClaims("Cleaning for your home", MINIMAL_FACTS)).toEqual([]);
  });
});

/**
 * No false positives (Q4) on everything that exists today. There is no eval corpus yet: Task 15's live eval
 * waits for the owner's key, so this covers the fixtures, the test samples and the prompt's own examples.
 */
describe("AI claim check: no false positives on what exists", () => {
  it.each(FIXTURES)("accepts the copy of fixture %s with its own facts", (name) => {
    const doc = SiteDocument.parse(loadFixture(name));
    expect(aiClaimIssues(doc.copy, doc.facts)).toEqual([]);
  });

  const SAMPLES = { FULL_FACTS, MINIMAL_FACTS, CAPS_FACTS: CAPS_SNAPSHOT.facts };
  it.each(Object.entries(SAMPLES))("accepts every template answer for %s (every trade, tone and goal)", (_name, facts) => {
    for (const trade of TRADES) for (const tone of TONES) for (const goal of GOALS) {
      const forTrade = { ...facts, trade };
      const result = checkDraft(forTrade, templateAnswer(forTrade, { ...BRIEF, tone, goal }));
      expect(result.ok, `${trade} ${tone} ${goal}`).toBe(true);
    }
  });

  it("accepts the prompt's own copy examples, on facts that back nothing", () => {
    // The prompt's examples of wording: ctaText "Request a quote", "our Contact page", and the ban's own "Apostrophes are fine".
    for (const text of ["Request a quote", "our Contact page", "Name the page instead, for example our Contact page."]) expect(aiClaims(text, MINIMAL_FACTS)).toEqual([]);
    expect(SYSTEM_PROMPT).toContain("Request a quote");
    expect(SYSTEM_PROMPT).toContain("our Contact page");
  });
});
