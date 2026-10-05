import { GOALS, TONES } from "@asksite/core";
import { DAYS, Facts, SiteDocument, TRADES, unbackedClaims } from "@asksite/site-schema";
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
    ["ins. after U+A78F", "Fully\uA78Fins. crew", ["ins."]],
    ["ins. after U+02D0", "Fully\u02D0ins. crew", ["ins."]],
    ["ins. after U+02C8 and a space", "Fully \u02C8ins. crew", ["ins."]],
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
    ["single quotes after a colon, no space", "Dana:'Best cleaners ever'", ["'Best cleaners ever'"]],
    ["single quotes after U+2012", "Dana\u2012'Best cleaners ever'", ["'Best cleaners ever'"]],
    ["single quotes after an en dash", "Dana\u2013'Best cleaners ever'", ["'Best cleaners ever'"]],
    ["single quotes after U+2212", "Dana\u2212'Best cleaners ever'", ["'Best cleaners ever'"]],
    ["single quotes after a hyphen", "Dana-'Best cleaners ever'", ["'Best cleaners ever'"]],
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

// The claim-word gaps of the claims review (2026-10-05): each evasion below was accepted by both checkers at 5b6a8bb. The new rules are AI-only.
describe("AI claim check: claim-word gaps", () => {
  const LICENSED_AND_INSURED = withFacts({ licences: [{ label: "Texas cleaner", number: "C-1" }], insured: true });

  refused(MINIMAL_FACTS, [
    ["zero costs", "Zero costs to you", ["Zero costs"]],
    ["freebie", "A freebie with every visit", ["freebie"]],
    ["freebies", "Freebies for new customers", ["Freebies"]],
    ["never charged", "Never charged a call-out fee", ["Never charged"]],
    ["never charges", "Never charges for a quote", ["Never charges"]],
    ["afterhours, closed", "Afterhours cleaning", ["Afterhours"]],
    ["every single day", "Open every single day", ["every single day"]],
    ["open everyday", "Open everyday", ["Open everyday"]],
    ["available everyday", "Available everyday in Austin", ["Available everyday"]],
    ["every holiday", "Open every holiday", ["every holiday"]],
    ["any holiday", "Open any holiday", ["any holiday"]],
    ["raving", "Neighbors are raving about us", ["raving"]],
    ["recommends us", "Everyone recommends us", ["recommends us"]],
    ["recommend us", "Locals recommend us", ["recommend us"]],
    ["vet every", "We vet every cleaner", ["vet every"]],
    ["vetting", "Careful vetting of the crew", ["vetting"]],
    ["vets all", "She vets all of them", ["vets all"]],
    ["lic and ins", "Fully lic and ins crew", ["lic and ins"]],
    ["lic & ins", "Fully lic & ins crew", ["lic & ins"]],
    ["lic&ins", "Fully lic&ins crew", ["lic&ins"]],
    ["lic. and ins, one dot", "Fully lic. and ins crew", ["lic.", "lic. and ins"]],
    ["lic and ins., one dot", "Fully lic and ins. crew", ["ins.", "lic and ins."]],
  ]);
  // A response time: "within one hour" like "within an hour", and an arrival phrase that leads in. The written residual: other
  // paraphrases ("we get to you fast", "a quick hour away") are accepted (the prompt's "Invent nothing: ... response times" is the backstop).
  refused(MINIMAL_FACTS, [
    ["within one hour", "We arrive within one hour", ["within one hour"]],
    // "dries within an hour" is refused today, so "dries within one hour" is the same class.
    ["dries within one hour", "Dries within one hour", ["within one hour"]],
    ["here in under an hour", "Here in under an hour", ["Here in under an hour"]],
    ["arrive in under an hour", "We arrive in under an hour", ["arrive in under an hour"]],
    ["at your door in less than an hour", "At your door in less than an hour", ["At your door in less than an hour"]],
    ["out to you in under an hour", "Out to you in under an hour", ["Out to you in under an hour"]],
    ["on site in under an hour", "On site in under an hour", ["On site in under an hour"]],
  ]);
  refused(EMERGENCY, [["no fact backs an arrival time", "Here in under an hour", ["Here in under an hour"]]]);
  // The gated words, backed.
  accepted(FREE, [
    ["zero costs with freeEstimates", "Zero costs to you"],
    ["freebie with freeEstimates", "A freebie with every visit"],
    ["freebies with freeEstimates", "Freebies for new customers"],
    ["never charged with freeEstimates", "Never charged a call-out fee"],
    ["never charges with freeEstimates", "Never charges for a quote"],
  ]);
  accepted(SEVEN_DAYS, [
    ["afterhours with hours on all 7 days", "Afterhours cleaning"],
    ["every single day with hours on all 7 days", "Open every single day"],
    ["open everyday with hours on all 7 days", "Open everyday"],
    ["available everyday with hours on all 7 days", "Available everyday in Austin"],
    ["every holiday with hours on all 7 days", "Open every holiday"],
    ["any holiday with hours on all 7 days", "Open any holiday"],
  ]);
  accepted(EMERGENCY, [["every single day with emergency247", "Open every single day"]]);
  refused(SIX_DAYS, [["six days of hours do not back every single day", "Open every single day", ["every single day"]]]);
  refused(FREE, [["freeEstimates does not back afterhours", "Afterhours cleaning", ["Afterhours"]]]);
  refused(INSURED, [["insurance does not back a freebie", "A freebie with every visit", ["freebie"]]]);
  // "lic and ins" needs the licence AND the insured fact.
  refused(LICENSED, [["a licence alone does not back lic and ins", "Fully lic and ins crew", ["lic and ins"]]]);
  refused(INSURED, [["insurance alone does not back lic and ins", "Fully lic & ins crew", ["lic & ins"]]]);
  accepted(LICENSED_AND_INSURED, [
    ["lic and ins with both facts", "Fully lic and ins crew"],
    ["lic & ins with both facts", "Fully lic & ins crew"],
    ["lic&ins with both facts", "Fully lic&ins crew"],
  ]);
  // False positives, each pinned: the narrow forms stay narrow.
  accepted(MINIMAL_FACTS, [
    ["everyday chores", "Everyday chores, done right"],
    ["everyday wear and tear", "Fixes everyday wear and tear"],
    ["holiday lights", "Holiday lights hung and taken down"],
    ["holiday cleaning", "Holiday cleaning for your home"],
    ["takes under an hour", "Drain cleaning takes under an hour"],
    ["done in under an hour", "Most jobs are done in under an hour"],
    ["takes less than an hour", "Drain cleaning takes less than an hour"],
    ["we recommend annual service", "We recommend annual service"],
    ["we recommend using a mat", "We recommend using a mat"],
    ["vet-owned", "A vet-owned business"],
    ["veteran owned", "Veteran owned and operated"],
    ["pet vet", "Pet vet clinic floors"],
    ["the ins and outs", "The ins and outs of drains"],
    ["freedom from clutter", "Freedom from clutter"],
    ["FreeFlow in a name", "FreeFlow drains"],
    ["daily alone", "Daily cleaning for busy offices"],
    ["known gap: a response time without an arrival phrase", "We get to you fast, a quick hour away"],
  ]);
  // AI-only: the owner checker accepts every refused wording above, on facts that back nothing.
  it.each([
    "Zero costs to you", "A freebie with every visit", "Freebies for new customers", "Never charged a call-out fee", "Never charges for a quote",
    "Afterhours cleaning", "Open every single day", "Open everyday", "Open every holiday", "Open any holiday", "Neighbors are raving about us",
    "Everyone recommends us", "We vet every cleaner", "Careful vetting of the crew", "Fully lic and ins crew", "Fully lic & ins crew",
    "Here in under an hour", "On site in under an hour",
  ])("leaves %s to the AI check: the owner checker accepts it", (text) => {
    expect(unbackedClaims(text, MINIMAL_FACTS)).toEqual([]);
  });
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

// An underscore before or after a wording is still that wording: site-schema's readings() adds a reading with "_" read as a space (one function for both checkers).
describe("AI claim check: an underscore hides nothing", () => {
  refused(MINIMAL_FACTS, [
    ["ins. after _", "Fully_ins. crew", ["ins."]],
    ["ins. after _ and space", "Fully _ins. crew", ["ins."]],
    ["ins. inside __", "Our _ins._ crew", ["ins."]],
    ["lic.", "Fully_lic. crew", ["lic."]],
    ["liability", "Fully_liability coverage", ["liability"]],
    ["vetted", "_Vetted_ cleaners", ["Vetted"]],
    ["after hours", "After_hours cleaning", ["After hours"]],
    ["after hours, _ next to the space", "After _hours cleaning", ["After hours"]],
    ["within the hour, __", "Within__the__hour", ["Within the hour"]],
    ["rave", "_rave_ cleaners", ["rave"]],
  ]);
  accepted(INSURED, [
    ["ins. backed", "Fully_ins. crew"],
    ["liability backed", "Fully_liability coverage"],
  ]);
  accepted(LICENSED, [["lic. backed", "Fully_lic. crew"]]);
  accepted(SEVEN_DAYS, [["after hours backed", "After_hours cleaning"]]);
});

// A symbol between the words of a multi-word wording is still that wording: readings() also reads U+00B7, U+2022, "~", "*", "|", U+2219, U+30FB and U+25CF as a space when glued between two non-space characters (a quote that opens right after one counts too, glued or not).
describe("AI claim check: a symbol separator hides nothing", () => {
  refused(MINIMAL_FACTS, [
    ["after hours, middle dot", "After\u00B7hours cleaning", ["After hours"]],
    ["after hours, bullet", "After\u2022hours cleaning", ["After hours"]],
    ["within the hour, tilde", "Within~the~hour", ["Within the hour"]],
    ["after hours, bar", "After|hours cleaning", ["After hours"]],
    ["quote after a bar", "Our motto|'clean homes'", ["'clean homes'"]],
    ["quote between asterisks", "Our*'Tidy'*crew", ["'Tidy'"]],
    ["quote between asterisks, text start", "*'Tidy'* crew", ["'Tidy'"]],
    ["quote in asterisks after a space", "Ask about *'the tidy crew'*", ["'the tidy crew'"]],
    ["quote in asterisks, motto", "Our motto *'clean homes'*", ["'clean homes'"]],
    ["quote in asterisks, motto colon", "Our motto: *'clean homes'*", ["'clean homes'"]],
    ["quote after a spaced bar", "Our motto |'clean homes'", ["'clean homes'"]],
    ["quote after a middle dot, text start", "\u00B7'Best crew ever' Dana", ["'Best crew ever'"]],
    ["quote in tildes, text start", "~'Best in Boise'~", ["'Best in Boise'"]],
    ["quote after a bar and an underscore", "Our motto_|'clean homes'", ["'clean homes'"]],
    // One row per remaining symbol of the quote opener's class, each not glued (so only the class catches it).
    ["quote after a spaced bullet", "Our motto \u2022'clean homes'", ["'clean homes'"]],
    ["quote after a bullet operator, text start", "\u2219'Best crew ever' Dana", ["'Best crew ever'"]],
    ["quote after a katakana middle dot, text start", "\u30FB'Tidy' crew", ["'Tidy'"]],
    ["quote after a spaced black circle", "Our motto \u25CF'clean homes'", ["'clean homes'"]],
  ]);
  accepted(SEVEN_DAYS, [["after hours backed, middle dot", "After\u00B7hours cleaning"]]);
  accepted(MINIMAL_FACTS, [
    ["trade and place", "Cleaning \u00B7 Austin"],
    ["pipe list", "Repairs | Installs"],
    ["bullet list", "Fast \u2022 Friendly \u2022 Local"],
    ["tilde list", "Kitchens ~ Baths"],
    ["list case, city and approved", "Kansas City \u00B7 Approved materials only"],
    ["list case, before and after", "Before \u00B7 After \u00B7 Hours vary by job"],
    ["list case, yes or no", "Yes or no \u00B7 Fees explained up front"],
  ]);
});

// A claim word spelled with separated single letters is still that wording: readings() joins each run of 2 or more single letters (a space, a hyphen, a dash or a dot with an optional space between them; all of it, or with the first letter, the last letter or both kept apart, or cut where the gap kind changes), on a few base readings, so a joined run reads like the same words typed solid. Initialisms that spell a claim word are refused like the word (the named false-positive note: "I.N.S." and "L.I.C.").
describe("AI claim check: separated single letters hide nothing", () => {
  refused(MINIMAL_FACTS, [
    ["free, spaces", "F R E E estimates today", ["FREE"]],
    ["free, hyphens", "F-R-E-E estimates", ["FREE"]],
    ["free, dots", "F.R.E.E. estimates", ["FREE"]],
    ["free, dots and spaces", "F. R. E. E. estimates", ["FREE"]],
    ["free, middle dots", "F\u00B7R\u00B7E\u00B7E estimates", ["FREE"]],
    ["free, underscores", "F_R_E_E estimates", ["FREE"]],
    ["licensed", "L I C E N S E D crew", ["LICENSED"]],
    ["insured", "I N S U R E D crew", ["INSURED"]],
    ["bonded", "B O N D E D crew", ["BONDED"]],
    ["guaranteed", "G U A R A N T E E D work", ["GUARANTEED"]],
    ["bbb", "B.B.B. member", ["BBB"]],
    // The named false-positive note: an initialism that spells a claim word is refused like the word.
    ["ins. initialism", "Fully I.N.S. crew", ["INS."]],
    ["lic. initialism", "Fully L.I.C. crew", ["LIC."]],
    // An article or I next to a spelled word (edge readings): each reads like its solid form, which is refused.
    ["edge: article and spaces", "Get a F R E E estimate", ["FREE"]],
    ["edge: A first", "A F R E E estimate for every home", ["FREE"]],
    ["edge: article and hyphens", "Get a F-R-E-E estimate", ["FREE"]],
    ["edge: article and dots", "Get a F.R.E.E. estimate", ["FREE"]],
    ["edge: bbb after an article", "We are a B.B.B. member", ["BBB"]],
    ["edge: bbb after I'm", "I'm a B.B.B. member", ["BBB"]],
    ["edge: licensed after A", "A L I C E N S E D crew", ["LICENSED"]],
    ["edge: bonded after A", "A B O N D E D crew", ["BONDED"]],
    ["edge: I and a word", "I G U A R A N T E E it", ["GUARANTEE"]],
    ["edge: a letter after the word", "Estimates are F R E E a promise", ["FREE"]],
    // A single-way look-alike inside a run is read as its letter.
    ["look-alike: f", "\u0192 R E E estimates", ["fREE"]],
    ["look-alike: E", "F R \u018E E estimates", ["FREE"]],
    ["look-alike: i", "L \u0131 C E N S E D crew", ["LiCENSED"]],
    // Two spelled words in a row (cut reading).
    ["cut: free estimates", "F-R-E-E E-S-T-I-M-A-T-E-S", ["FREE"]],
    ["cut: free estimates, dots", "F.R.E.E. E.S.T.I.M.A.T.E.S.", ["FREE"]],
    ["cut: bonded and insured", "B-O-N-D-E-D A-N-D I-N-S-U-R-E-D", ["BONDED", "INSURED"]],
    ["cut: guaranteed work", "G-U-A-R-A-N-T-E-E-D W-O-R-K", ["GUARANTEED"]],
    ["cut: top rated", "T-O-P R-A-T-E-D crew", ["TOP RATED"]],
    ["cut: five star", "F-I-V-E S-T-A-R crew", ["FIVE STAR"]],
    ["cut: same day", "S-A-M-E D-A-Y service", ["SAME DAY"]],
    ["cut: no charge", "N-O C-H-A-R-G-E", ["NO CHARGE"]],
    ["cut: insured and (shows INSURED)", "I N S U R E D A-N-D", ["INSURED"]],
    // Runs of 2 join: the owner copy refuses "NO charge", "day OR night" and "OF the week"; the AI copy also "NO fees", "ON the house" and "within AN hour".
    ["2-run: no charge", "N O charge visits", ["NO charge"]],
    ["2-run: no cost", "N-O cost visits", ["NO cost"]],
    ["2-run: day or night", "day O R night", ["day OR night"]],
    ["2-run: day-or-night", "day-O-R-night", ["day-OR-night"]],
    ["2-run: of the week", "Seven days O F the week", ["Seven days OF the week"]],
    ["2-run: no fees (AI only)", "N O fees ever", ["NO fees"]],
    ["2-run: on the house (AI only)", "Quotes are O N the house", ["ON the house"]],
    ["2-run: within an hour (AI only)", "Back within A N hour", ["within AN hour"]],
    // An apostrophe: the right side of a run is not guarded, "F R E E's" is still the word FREE.
    ["apostrophe: free's", "F R E E's the word", ["FREE"]],
    ["apostrophe: bbb's", "B B B's pledge", ["BBB"]],
    ["apostrophe: bbb's rating", "B B B's rating", ["rating"]],
    // A kept dot gap is still refused when the spelled word is: "a.F.R.E.E." reads "a. FREE.".
    ["edge: dot after a letter", "a.F.R.E.E. estimates", ["FREE"]],
    // A word-break letter after the word (checkDraft; its solid form is refused too).
    ["word-break: free", "Estimates are F R E E\u1D09", ["FREE"]],
    ["word-break: two-way letter first", "\u028B F R E E\u1D09", ["FREE"]],
    // NAMED FALSE POSITIVES (claims.ts): a ". " gap joins a run across a sentence end ("SAY", all joined); a letter next to a
    // spelled run is read apart, so an inner claim word counts (the solid "ABBB" is accepted).
    ["run across a sentence end: SAY", "We stock size S. A Y fitting", ["SAY"]],
    ["letter next to a run: BBB", "A B B B", ["BBB"]],
    // NAMED FALSE POSITIVE: U+00B4 is no guarded apostrophe (copy's NFKC makes it a space and U+0301).
    ["apostrophe: U+00B4", "It\u00B4s a Y fitting", ["saY"]],
  ]);
  accepted(FREE, [["free backed", "F R E E estimates"]]);
  accepted(LICENSED, [
    ["licensed backed", "L I C E N S E D crew"],
    ["lic. initialism backed", "Fully L.I.C. crew"],
  ]);
  accepted(INSURED, [["ins. initialism backed", "Fully I.N.S. crew"]]);
  accepted(MINIMAL_FACTS, [
    ["ABC", "A B C Plumbing"],
    ["U.S.", "U.S. owned"],
    ["plan", "Plan A or B"],
    ["initials", "J. R. Smith Roofing"],
    ["K and S", "K & S Cleaning"],
    ["TLC dots", "T.L.C. Home Care"],
    ["TLC dots and spaces", "T. L. C. Home Care"],
    ["HVAC spaces", "H V A C repair"],
    ["HVAC dots", "H.V.A.C. repair"],
    ["DIY", "D.I.Y. tips"],
    ["letters glued to a word", "L I C E N Sing"],
    // Solid "ASAP scheduling" is accepted (owner and AI copy), so the spelled forms are too.
    ["ASAP solid", "ASAP scheduling"],
    ["ASAP dots", "A.S.A.P. scheduling"],
    ["ASAP spaces", "A S A P scheduling"],
    // An apostrophe before a letter makes it no single letter: "'s a Y" must not join into "saY" (the AI copy refuses "say"). Accepted at 9f5ddf5.
    ["apostrophe: It's a Y", "It's a Y fitting"],
    ["apostrophe: capitals", "IT'S A Y FITTING"],
    ["apostrophe: Y-shaped", "That's a Y-shaped drain"],
    ["apostrophe: there's", "There's a Y branch under the sink"],
    ["apostrophe: here's", "Here's a Y joint we fit"],
    ["apostrophe: owner's", "Owner's a Y fitting fan"],
    ["apostrophe: U+2019", "It\u2019s a Y fitting"],
    ["apostrophe: U+02BC", "It\u02BCs a Y fitting"],
    ["apostrophe: U+0060", "It`s a Y fitting"],
    ["apostrophe: U+2032", "It\u2032s a Y fitting"],
    ["apostrophe: U+201B", "It\u201Bs a Y fitting"],
    // A kept dot gap is a sentence end, not a web address: "N.C.O." must not read "N.CO".
    ["dot gap: N.C.O.", "Veteran N.C.O. owned"],
    ["dot gap: C.I.O.", "Ask our C.I.O. about it"],
    ["dot gap: M.U.S.C.", "M.U.S.C. trained nurse"],
    ["dot gap: N.C.O.A.", "N.C.O.A. address checks"],
    // Ordinary runs of 2 (accepted at 9f5ddf5; each reads like its solid form).
    ["2-run: U.S.", "U.S. owned"],
    ["2-run: initials", "J. R. Smith Roofing"],
    ["2-run: A.C.", "A.C. repair"],
    ["2-run: T V", "T V mounting"],
    ["2-run: A/C", "A/C repair"],
    ["2-run: B C", "Unit B C"],
    ["2-run: grades", "Grades A B C"],
    ["2-run: R.V.", "R.V. service"],
    ["2-run: a I", "a I helper"],
    ["2-run: options", "Option A, B, C"],
    ["2-run: Henry", "Henry V I I I style"],
    ["2-run: a.m.", "From early a.m. to late p.m."],
    ["2-run: A to Z", "A to Z cleaning"],
    ["2-run: U-turn", "X-ray and T-shirt and U-turn"],
    ["2-run: J. R. R.", "J. R. R. Smith Roofing"],
    ["2-run: I a m", "I a m here"],
  ]);
  refused(MINIMAL_FACTS, [["quote mark U+2018 (as solid)", "It\u2018s a Y fitting", ["\u2018"]]]);
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
