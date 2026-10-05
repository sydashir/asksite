// An underscore before or after a claim word is still a claim: "_" is a word character, so it hid the word from every
// rule that needs a word boundary, while the page shows the word to the reader. readings() (claims.ts) adds a reading with
// "_" read as a space; asReadOnPage and the typed reading are unchanged.
// Tightening claims.ts also applies to owner-written copy and to the re-parse of stored documents (the moderator
// accepts this before launch: no live data).
import { describe, expect, it } from "vitest";
import { Facts, unbackedClaims } from "../src/index.ts";

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
