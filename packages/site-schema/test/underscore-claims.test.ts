// An underscore before or after a claim word is still a claim: "_" is a word character, so it hid the word from every
// rule that needs a word boundary, while the page shows the word to the reader. readings() (claims.ts) adds a reading with
// "_" read as a space; asReadOnPage and the typed reading are unchanged.
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

describe("an underscore does not hide a claim word", () => {
  // [text, the word found, the facts that back it (undefined: nothing backs it)]
  const NEEDS: ReadonlyArray<readonly [string, string, Facts]> = [
    ["Our _licensed_ crew", "licensed", withFacts({ licences: [{ label: "Idaho cleaner", number: "C-1" }] })],
    ["Fully _insured crew", "insured", withFacts({ insured: true })],
    ["Fully_insured crew", "insured", withFacts({ insured: true })],
    ["Our _emergency_ line", "emergency", withFacts({ emergency247: true })],
    ["Fully_free estimates", "free", withFacts({ freeEstimates: true })],
    ["Estimates are free_", "free", withFacts({ freeEstimates: true })],
    // "_" next to the space between two words, or "__", joins a multi-word claim like one space.
    ["No _charge estimates", "No charge", withFacts({ freeEstimates: true })],
    ["Around__the__clock help", "Around the clock", withFacts({ emergency247: true })],
  ];
  it.each(NEEDS)("refuses %s without the fact and accepts it with the fact", (text, word, backed) => {
    expect(unbackedClaims(text, NONE)).toEqual([word]);
    expect(unbackedClaims(text, backed)).toEqual([]);
  });

  it.each([
    ["_certified_ pros", "certified"],
    ["top_rated crew", "top rated"],
    ["Serving you _since_ then", "since"],
    ["Visit mop_cleaning.com", "cleaning.com"],
    ["Visit my_site.com", "site.com"],
    ["Fully_bonded crew", "bonded"],
    ["Award _winning crew", "Award winning"],
    ["Same__day service", "Same day"],
  ])("refuses %s whatever the facts", (text, word) => {
    expect(unbackedClaims(text, NONE)).toEqual([word]);
    expect(unbackedClaims(text, withFacts({ insured: true, freeEstimates: true, emergency247: true, yearFounded: 2010 }))).toEqual([word]);
  });

  it("still accepts copy with an underscore that holds no claim", () => {
    expect(unbackedClaims("Our crew_cleans_homes", NONE)).toEqual([]);
  });
});

// A symbol between the words of a multi-word claim is still a claim: readings() (claims.ts) reads "_" and the symbol
// separators U+00B7, U+2022, "~", "*" and "|" as a space too. A single claim word next to one was refused already.
describe("a symbol separator does not hide a multi-word claim", () => {
  const SEVEN = withFacts({ emergency247: true });
  it.each([
    ["Award\u00B7winning crew", "Award winning"],
    ["Award\u2022winning crew", "Award winning"],
    ["Same\u00B7day service", "Same day"],
    ["Same\u2022day service", "Same day"],
    ["Award~winning crew", "Award winning"],
    ["Award*winning crew", "Award winning"],
    ["Award|winning crew", "Award winning"],
    ["Award \u00B7 winning crew", "Award winning"],
  ])("refuses %s whatever the facts", (text, word) => {
    expect(unbackedClaims(text, NONE)).toEqual([word]);
    expect(unbackedClaims(text, withFacts({ insured: true, freeEstimates: true, emergency247: true, yearFounded: 2010 }))).toEqual([word]);
  });

  it("refuses Seven\u00B7days\u00B7a\u00B7week without 24/7 or seven days of hours, accepts it with either", () => {
    for (const text of ["Seven\u00B7days\u00B7a\u00B7week", "Seven\u2022days\u2022a\u2022week"]) {
      expect(unbackedClaims(text, NONE)).toEqual(["Seven days a week"]);
      expect(unbackedClaims(text, SEVEN)).toEqual([]);
      expect(unbackedClaims(text, withFacts({ hours: [{ days: [...DAYS], opens: "08:00", closes: "17:00" }] }))).toEqual([]);
    }
  });

  it("refuses owner-edited copy through SiteDocument.safeParse", () => {
    for (const text of ["Award\u00B7winning crew", "Same\u2022day service", "Award|winning crew"]) {
      const result = SiteDocument.safeParse({ ...ownerDocument, copy: { ...ownerDocument.copy, heroHeadline: text } });
      expect(result.success, text).toBe(false);
    }
    expect(SiteDocument.safeParse(ownerDocument).success).toBe(true);
  });

  // Ordinary uses of the same symbols between words that are not a claim.
  it.each([
    "Plumbing \u00B7 Austin",
    "Repairs | Installs",
    "Fast \u2022 Friendly \u2022 Local",
    "Mon\u2013Fri \u00B7 8\u20135",
    "Kitchens ~ Baths",
  ])("still accepts %s", (text) => {
    expect(unbackedClaims(text, NONE)).toEqual([]);
  });
});
