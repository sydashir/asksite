// A claim word spelled with separated single letters is still that claim word: readings() (claims.ts) adds a reading, built
// from every earlier reading, with each run of 3 or more single letters joined, so a joined run behaves exactly like the same
// acronym typed solid. A run's letters are single (no letter or digit glued to them) and each pair has ONE gap: a space, a
// hyphen, a dash, or a dot with an optional space after it. Runs of 2 never join.
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
    // A run of 2 never joins: "N O" stays two letters, so no "no charge".
    "N O charge visits",
    "N-O cost visits",
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
    ["INS. crew", "I.N.S. crew"],
    ["LIC. crew", "L.I.C. crew"],
  ])("reads %s like %s", (solid, spelled) => {
    expect(unbackedClaims(spelled, NONE)).toEqual(unbackedClaims(solid, NONE));
    expect(unbackedClaims(spelled, EVERYTHING)).toEqual(unbackedClaims(solid, EVERYTHING));
  });
});
