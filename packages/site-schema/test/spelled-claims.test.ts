// A claim word spelled with separated single letters is still that claim word: readings() (claims.ts) adds readings, built
// from a few base readings, with each run of 2 or more single letters joined (all of it; or with the first letter, the last
// letter or both kept apart, so an article or "I" next to the word is not swallowed; or cut at the gaps where the gap kind
// changes, so two spelled words in a row stay two words), so a joined run behaves exactly like the same words typed solid. A
// run's letters are single (no letter or digit glued to them, and none after a letter or digit plus an apostrophe) and each
// pair has ONE gap: a space, a hyphen, a dash, or a dot with an optional space after it.
// Tightening claims.ts also applies to owner-written copy and to the re-parse of stored documents (the moderator
// accepts this before launch: no live data).
import { describe, expect, it } from "vitest";
import { DAYS, Facts, SiteDocument, unbackedClaims } from "../src/index.ts";

const base = {
  businessName: "Mop",
  trade: "cleaning",
  phone: "+12085550107",
  email: "hi@example.com",
  location: { city: "Boise", state: "ID" },
  serviceArea: { places: ["Boise"] },
  services: [{ name: "House cleaning" }],
};
const NONE = Facts.parse(base);
const ownerDocument = {
  facts: base,
  copy: {
    heroHeadline: "A spotless home without lifting a finger",
    heroSubheadline: "Friendly, careful cleaners for homes across Boise.",
    ctaText: "Book a cleaning",
    serviceDescriptions: [{ service: "House cleaning", description: "Weekly or one-off cleans." }],
  },
  layout: [
    { id: "hero", variant: "centered" },
    { id: "services", variant: "cards" },
    { id: "serviceArea", variant: "split" },
    { id: "contact", variant: "card" },
  ],
  theme: { palette: "green-amber", font: "clean" },
};
const withFacts = (extra: Record<string, unknown>): Facts => Facts.parse({ ...base, ...extra });
const FREE = withFacts({ freeEstimates: true });
const LICENSED = withFacts({ licences: [{ label: "Idaho cleaner", number: "C-1" }] });
const INSURED = withFacts({ insured: true });
const EVERYTHING = withFacts({ insured: true, freeEstimates: true, emergency247: true, yearFounded: 2010, hours: [{ days: [...DAYS], opens: "08:00", closes: "17:00" }] });

describe("separated single letters do not hide a claim word", () => {
  // [text, the word found, the facts that back it (undefined: nothing backs it)]
  const NEEDS: ReadonlyArray<readonly [string, string, Facts]> = [
    ["F R E E estimates today", "FREE", FREE],
    ["F-R-E-E estimates", "FREE", FREE],
    ["F.R.E.E. estimates", "FREE", FREE],
    ["F. R. E. E. estimates", "FREE", FREE],
    ["F–R–E–E estimates", "FREE", FREE],
    ["F·R·E·E estimates", "FREE", FREE],
    ["F_R_E_E estimates", "FREE", FREE],
    ["F*R*E*E estimates", "FREE", FREE],
    ["L I C E N S E D crew", "LICENSED", LICENSED],
    ["I N S U R E D crew", "INSURED", INSURED],
  ];
  it.each(NEEDS)("refuses %s without the fact and accepts it with the fact", (text, word, backed) => {
    expect(unbackedClaims(text, NONE)).toEqual([word]);
    expect(unbackedClaims(text, backed)).toEqual([]);
  });

  it.each([
    ["B O N D E D crew", "BONDED"],
    ["G U A R A N T E E D work", "GUARANTEED"],
    ["B.B.B. member", "BBB"],
    ["B-B-B member", "BBB"],
    ["B•B•B member", "BBB"],
  ])("refuses %s whatever the facts", (text, word) => {
    expect(unbackedClaims(text, NONE)).toEqual([word]);
    expect(unbackedClaims(text, EVERYTHING)).toEqual([word]);
  });

  it("refuses owner-edited copy through SiteDocument.safeParse, naming the claim", () => {
    for (const [text, word] of [
      ["F R E E estimates today", "FREE"],
      ["F.R.E.E. estimates", "FREE"],
      ["L I C E N S E D crew", "LICENSED"],
      ["B O N D E D crew", "BONDED"],
      ["G U A R A N T E E D work", "GUARANTEED"],
      ["F·R·E·E estimates", "FREE"],
    ]) {
      const result = SiteDocument.safeParse({ ...ownerDocument, copy: { ...ownerDocument.copy, heroHeadline: text } });
      expect(result.success, text).toBe(false);
      expect(result.error?.issues.map((issue) => issue.message).join(" "), text).toContain(JSON.stringify(word));
    }
    expect(SiteDocument.safeParse(ownerDocument).success).toBe(true);
    expect(SiteDocument.safeParse({ ...ownerDocument, facts: { ...base, freeEstimates: true }, copy: { ...ownerDocument.copy, heroHeadline: "F R E E estimates" } }).success).toBe(true);
  });

  // Initials, acronyms that are not claim words, and letters inside words stay as typed. The digit rows are claims-checker only
  // (copy bans digits).
  it.each([
    "A B C Plumbing",
    "A-1 Plumbing",
    "U.S. owned",
    "Plan A or B",
    "J. R. Smith Roofing",
    "K & S Cleaning",
    "T.L.C. Home Care",
    "T. L. C. Home Care",
    "H V A C repair",
    "H.V.A.C. repair",
    "D.I.Y. tips",
    "P.O. Box 12",
    // A letter glued to a word is not a single letter: "L I C E N S" + "ing" must not join into "LICENSing".
    "L I C E N Sing",
  ])("still accepts %s", (text) => {
    expect(unbackedClaims(text, NONE)).toEqual([]);
  });

  // PRINCIPLE: a joined run behaves exactly like the same acronym typed solid. "ASAP scheduling" is accepted today, so is the spelled form.
  it.each([
    ["ASAP scheduling", "A.S.A.P. scheduling"],
    ["ASAP scheduling", "A S A P scheduling"],
    ["TLC Home Care", "T.L.C. Home Care"],
    ["HVAC repair", "H-V-A-C repair"],
    ["BBB member", "B.B.B. member"],
  ])("reads %s like %s", (solid, spelled) => {
    expect(unbackedClaims(spelled, NONE)).toEqual(unbackedClaims(solid, NONE));
    expect(unbackedClaims(spelled, EVERYTHING)).toEqual(unbackedClaims(solid, EVERYTHING));
  });

  // Owner copy: neither form is a claim ("ins." and "lic." are AI-copy words only), so this pins only that the two forms agree.
  // The AI copy refuses both: ai-claims.test.ts rows "ins. initialism" and "lic. initialism" (generation/test).
  it.each([
    ["INS. crew", "I.N.S. crew"],
    ["LIC. crew", "L.I.C. crew"],
  ])("owner copy: neither %s nor %s is a claim", (solid, spelled) => {
    expect(unbackedClaims(solid, NONE)).toEqual([]);
    expect(unbackedClaims(spelled, NONE)).toEqual([]);
    expect(unbackedClaims(spelled, EVERYTHING)).toEqual(unbackedClaims(solid, EVERYTHING));
  });
});

// Every row below behaves EXACTLY like its solid form (the principle): [spelled, solid, the words found with no facts].
type Row = readonly [spelled: string, solid: string, words: readonly string[]];
const like = (rows: readonly Row[]) =>
  it.each(rows)("refuses %s like %s", (spelled, solid, words) => {
    expect(unbackedClaims(spelled, NONE)).toEqual(words);
    expect(unbackedClaims(solid, NONE)).toEqual(unbackedClaims(spelled, NONE));
    expect(unbackedClaims(spelled, EVERYTHING)).toEqual(unbackedClaims(solid, EVERYTHING));
  });

describe("an article or I next to a spelled word does not hide it (edge readings)", () => {
  like([
    ["Get a F R E E estimate", "Get a FREE estimate", ["FREE"]],
    ["A F R E E estimate for every home", "A FREE estimate for every home", ["FREE"]],
    ["Get a F-R-E-E estimate", "Get a FREE estimate", ["FREE"]],
    ["Get a F.R.E.E. estimate", "Get a FREE. estimate", ["FREE"]],
    ["We are a B.B.B. member", "We are a BBB. member", ["BBB"]],
    ["I'm a B.B.B. member", "I'm a BBB. member", ["BBB"]],
    ["A L I C E N S E D crew", "A LICENSED crew", ["LICENSED"]],
    ["A B O N D E D crew", "A BONDED crew", ["BONDED"]],
    ["I G U A R A N T E E it", "I GUARANTEE it", ["GUARANTEE"]],
    ["Estimates are F R E E a promise", "Estimates are FREE a promise", ["FREE"]],
    ["a.F.R.E.E. estimates", "a.FREE. estimates", ["FREE"]],
    // A word-break letter after the word (the word-break base; a two-way letter before it makes the half 2).
    ["Estimates are F R E E\u1D09", "Estimates are FREE\u1D09", ["FREE"]],
    ["\u028B F R E E\u1D09", "\u028BFREE\u1D09", ["FREE"]],
  ]);
});

// A "." gap kept apart is written ". " (a sentence end), not ".": an initialism ending in C.O, I.O or U.S would read as a web address.
describe("a kept dot gap reads as a sentence end, not a web address", () => {
  it.each(["Veteran N.C.O. owned", "Ask our C.I.O. about it", "M.U.S.C. trained nurse", "N.C.O.A. address checks"])("accepts %s", (text) => {
    expect(unbackedClaims(text, NONE)).toEqual([]);
    expect(unbackedClaims(text, EVERYTHING)).toEqual([]);
  });
});

describe("two spelled words in a row stay two words (cut reading)", () => {
  like([
    ["F-R-E-E E-S-T-I-M-A-T-E-S", "FREE ESTIMATES", ["FREE"]],
    ["F.R.E.E. E.S.T.I.M.A.T.E.S.", "FREE. ESTIMATES.", ["FREE"]],
    ["B-O-N-D-E-D A-N-D I-N-S-U-R-E-D", "BONDED AND INSURED", ["BONDED", "INSURED"]],
    ["G-U-A-R-A-N-T-E-E-D W-O-R-K", "GUARANTEED WORK", ["GUARANTEED"]],
    ["T-O-P R-A-T-E-D crew", "TOP RATED crew", ["TOP RATED"]],
    ["F-I-V-E S-T-A-R crew", "FIVE STAR crew", ["FIVE STAR"]],
    ["S-A-M-E D-A-Y service", "SAME DAY service", ["SAME DAY"]],
    ["N-O C-H-A-R-G-E", "NO CHARGE", ["NO CHARGE"]],
    ["a F-R-E-E", "a FREE", ["FREE"]],
    // The cut reading is read first, so the message shows "INSURED" (the all-joined reading would show "INSUREDAND").
    ["I N S U R E D A-N-D", "INSURED AND", ["INSURED"]],
  ]);
});

describe("a look-alike letter inside a spelled run is read as the letter it looks like", () => {
  like([
    ["\u0192 R E E estimates", "\u0192REE estimates", ["fREE"]],
    ["F R \u018E E estimates", "FR\u018EE estimates", ["FREE"]],
    ["L \u0131 C E N S E D crew", "L\u0131CENSED crew", ["LiCENSED"]],
  ]);
});

// NAMED RESIDUALS (claims.ts, LETTER_RUN): spelled runs that are NOT read like their solid form. Pinned so a change shows.
describe("named residuals: spelled runs that stay accepted", () => {
  it.each([
    ["two spelled words with the same gap kind", "F R E E Q U O T E S"],
    ["a gap that is not one of the four", "F - R - E - E estimates"],
    ["a gap that is not one of the four", "F/R/E/E estimates"],
    ["a gap kind that changes inside a word", "N O-C-H-A-R-G-E"],
    ["two single-letter words before a spelled word", "I a F R E E estimates"],
    ["a hyphen between two space-spelled words", "S A M E-D A Y service"],
    ["a hyphen between two space-spelled words", "F R E E-Q U O T E S"],
    ["two spelling styles in one phrase", "Get a F R E E E-S-T-I-M-A-T-E"],
    ["two spelling styles in one phrase", "Book a S A M E D-A-Y visit"],
    ["a spelled word glued after a letter and an apostrophe", "Our'F R E E estimates"],
    ["a spelled word glued after a letter and an apostrophe", "Our`F R E E estimates"],
    ["a two-way look-alike read its second way", "I N S \u028B R E D crew"],
  ])("accepts (%s) %s", (_why, text) => {
    expect(unbackedClaims(text, NONE)).toEqual([]);
  });
});

describe("runs of 2 single letters join", () => {
  like([
    ["N O charge visits", "NO charge visits", ["NO charge"]],
    ["N-O cost visits", "NO cost visits", ["NO cost"]],
    ["day O R night", "day OR night", ["day OR night"]],
    ["day-O-R-night", "day-OR-night", ["day-OR-night"]],
    ["Seven days O F the week", "Seven days OF the week", ["Seven days OF the week"]],
  ]);
});

describe("an apostrophe before a letter makes it no single letter", () => {
  // The right side is NOT guarded: a spelled word that ends before "'s" is still a spelled word.
  like([
    ["F R E E's the word", "FREE's the word", ["FREE"]],
    ["B B B's pledge", "BBB's pledge", ["BBB"]],
  ]);
  it("refuses B B B's rating (its own word \"rating\" is refused with or without the spelling)", () => {
    expect(unbackedClaims("B B B's rating", NONE)).toEqual(["rating"]);
    expect(unbackedClaims("BBB's rating", NONE)).toEqual(["BBB"]);
  });

  // The solid form is accepted, so the spelled form is too: it was accepted at 9f5ddf5 and refused ("saY") at a3d2f2a.
  it.each([
    "It's a Y fitting",
    "IT'S A Y FITTING",
    "That's a Y-shaped drain",
    "There's a Y branch under the sink",
    "Here's a Y joint we fit",
    "Owner's a Y fitting fan",
    "It\u2019s a Y fitting",
    "It\u02BCs a Y fitting",
    "It`s a Y fitting",
    "It\u2032s a Y fitting",
    "It\u201Bs a Y fitting",
  ])("accepts %s", (text) => {
    expect(unbackedClaims(text, NONE)).toEqual([]);
    expect(unbackedClaims(text, EVERYTHING)).toEqual([]);
  });
  // U+2018 is refused as a quote mark (NEVER_IN_COPY) in the solid form too, and it is only that, not "saY".
  it("refuses the quote mark U+2018 in \"It\u2018s a Y fitting\", like the solid form, and nothing else", () => {
    expect(unbackedClaims("It\u2018s a Y fitting", NONE)).toEqual(["\u2018"]);
  });
});

// NAMED FALSE POSITIVE: U+00B4 is no guarded apostrophe; copy's NFKC turns it into a space and U+0301, so "It\u00B4s a Y fitting" is refused as "saY".
describe("the acute accent U+00B4 is a named false positive", () => {
  it("refuses it as saY, directly and through the document", () => {
    expect(unbackedClaims("It\u00B4s a Y fitting", NONE)).toEqual(["saY"]);
    const result = SiteDocument.safeParse({ ...ownerDocument, copy: { ...ownerDocument.copy, heroHeadline: "It\u00B4s a Y fitting" } });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join(" ")).toContain('"saY"');
  });
});

// NAMED FALSE POSITIVES (claims.ts): a single letter before or after a spelled run is read apart, so an inner claim word counts,
// as for I.N.S. and L.I.C. The solid "ABBB" is accepted, so the principle does not hold here. And a ". " gap joins a run across
// the end of a sentence: "S. A Y" reads "SAY" (all joined).
describe("a letter next to a spelled run, a run across a sentence end: named false positives", () => {
  it.each([
    ["We stock size S. A Y fitting", "SAY"],
    ["A B B B", "BBB"],
  ])("refuses %s", (text, word) => {
    expect(unbackedClaims(text, NONE)).toEqual([word]);
  });
  it("accepts the solid ABBB", () => {
    expect(unbackedClaims("ABBB", NONE)).toEqual([]);
  });
});

describe("the new spelled forms through SiteDocument.safeParse", () => {
  it("refuses owner-edited copy, naming the claim, and accepts an apostrophe before a single letter", () => {
    const parse = (text: string) => SiteDocument.safeParse({ ...ownerDocument, copy: { ...ownerDocument.copy, heroHeadline: text } });
    const refused: ReadonlyArray<readonly [string, string]> = [
      ["Get a F R E E estimate", "FREE"],
      ["Estimates are F R E E a promise", "FREE"],
      ["F-R-E-E E-S-T-I-M-A-T-E-S", "FREE"],
      ["B-O-N-D-E-D A-N-D I-N-S-U-R-E-D", "BONDED"],
      ["N O charge visits", "NO charge"],
      ["F R E E's the word", "FREE"],
      ["Estimates are F R E E\u1D09", "FREE"],
      ["\u028B F R E E\u1D09", "FREE"],
    ];
    for (const [text, word] of refused) {
      const result = parse(text);
      expect(result.success, text).toBe(false);
      expect(result.error?.issues.map((issue) => issue.message).join(" "), text).toContain(JSON.stringify(word));
    }
    for (const text of ["It's a Y fitting", "That's a Y-shaped drain", "U.S. owned", "J. R. Smith Roofing", "Veteran N.C.O. owned", "Ask our C.I.O. about it", "M.U.S.C. trained nurse", "N.C.O.A. address checks", "It`s a Y fitting"]) expect(parse(text).success, text).toBe(true);
  });
});

describe("ordinary initials and letters stay as they were (runs of 2)", () => {
  // [spelled, the same words typed solid (null: no solid form, nothing to refuse)]. Each reads as it did at 9f5ddf5 ("E.P.A. certified crew": the word "certified" is its own claim, as in the solid form).
  it.each<readonly [string, string | null]>([
    ["U.S. owned", "US. owned"],
    ["P.O. Box 12", "PO. Box 12"],
    ["J. R. Smith Roofing", "JR. Smith Roofing"],
    ["A.C. repair", null],
    ["T V mounting", "TV mounting"],
    ["A/C repair", null],
    ["Plan A or B", null],
    ["Unit B C", "Unit BC"],
    ["U.S.A. owned and run", "USA. owned and run"],
    ["Serving N.Y.C. homes", "Serving NYC. homes"],
    ["L.A. based crew", "LA. based crew"],
    ["J. R. R. Smith Roofing", "JRR. Smith Roofing"],
    ["Grades A B C", "Grades ABC"],
    ["R.V. service", null],
    ["U.V. lights", null],
    ["H.O.A. rules respected", "HOA. rules respected"],
    ["E.P.A. certified crew", "EPA. certified crew"],
    ["E.P.A. lead safe crew", "EPA. lead safe crew"],
    ["S.O.S. calls answered", "SOS. calls answered"],
    ["I a m here", "Iam here"],
    ["a I helper", null],
    ["Option A, B, C", null],
    ["Option A, B or C", null],
    ["Henry V I I I style", "Henry VIII style"],
    ["Q & A", null],
    ["P.S. we love dogs", null],
    ["We fix it, e.g. a leak", "We fix it, eg. a leak"],
    ["We fix it, i.e. a tune up", null],
    ["From early a.m. to late p.m.", null],
    ["A to Z cleaning", null],
    ["X-ray and T-shirt and U-turn", null],
    ["Serving D.C. and nearby", null],
    ["C.S. Lewis fans welcome", null],
    ["A.A.A. approved shop", "AAA. approved shop"],
    ["F.A.Q. answers", "FAQ. answers"],
    ["R.S.V.P. by phone", "RSVP. by phone"],
    ["V.I.P. service", "VIP. service"],
    ["S.U.V. detailing", "SUV. detailing"],
    ["B.B.Q. cleaning", "BBQ. cleaning"],
    ["O.S.H.A. trained crew", "OSHA. trained crew"],
    ["N.A.T.E. trained techs", "NATE. trained techs"],
    ["Serving L.I.C. and Astoria", "Serving LIC. and Astoria"],
    ["Help with I.N.S. paperwork", "Help with INS. paperwork"],
    ["Ask about our a.k.a. names", "Ask about our aka. names"],
    ["S.A.I.D. principle training", "SAID. principle training"],
    ["Let's a B C", null],
    ["It's a P-trap", null],
    ["It's a U-bend", null],
    ["We'd a Y", null],
  ])("reads %s like its solid form (nothing is added by the spelled-run readings)", (spelled, solid) => {
    for (const facts of [NONE, EVERYTHING]) expect(unbackedClaims(spelled, facts)).toEqual(solid === null ? [] : unbackedClaims(solid, facts));
  });
});
