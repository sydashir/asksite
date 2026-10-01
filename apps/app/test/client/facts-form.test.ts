import { describe, expect, it } from "vitest";
import {
  altTextWarning,
  daysOfEntry,
  suggestSlug,
  hoursToRows,
  phoneInput,
  phoneToFacts,
  priceInput,
  priceToFacts,
  rowsToHours,
  yearsInput,
  yearsToFacts,
} from "../../src/client/lib/facts-form.ts";
import { fieldId, getIn, moveItem, setIn } from "../../src/client/lib/values.ts";

describe("phone", () => {
  it.each([
    ["(512) 555-0142", "+15125550142"],
    ["512.555.0142", "+15125550142"],
    ["1 512 555 0142", "+15125550142"],
    ["512", "512"],
    ["  call me ", "  call me "],
  ])("%s -> %s", (input, facts) => {
    expect(phoneToFacts(input)).toBe(facts);
  });

  it("shows E.164 in the familiar US format and anything else as typed", () => {
    expect(phoneInput("+15125550142")).toBe("(512) 555-0142");
    expect(phoneInput("512")).toBe("512");
    expect(phoneInput(undefined)).toBe("");
  });
});

describe("price", () => {
  it.each([
    ["", undefined],
    ["89", 89],
    ["$1,250", 1250],
    ["ninety", "ninety"],
    ["89.50", "89.50"],
    ["1,250,000", 1250000],
    ["$1,25", "$1,25"],
    ["1,25", "1,25"],
    ["12,50", "12,50"],
    ["1,2500", "1,2500"],
    [",250", ",250"],
    ["1,250,", "1,250,"],
  ])("%j -> %j", (input, facts) => {
    expect(priceToFacts(input)).toBe(facts);
  });

  it("shows a stored price as text", () => {
    expect(priceInput(1250)).toBe("1250");
    expect(priceInput(undefined)).toBe("");
  });
});

describe("years in business", () => {
  it("converts years to a founding year and back (Plan 1 Decision #6)", () => {
    expect(yearsToFacts("10", 2026)).toBe(2016);
    expect(yearsToFacts("0", 2026)).toBe(2026);
    expect(yearsInput(2016, 2026)).toBe("10");
  });

  it("keeps input that is not a whole number of years, so the schema reports it", () => {
    expect(yearsToFacts("", 2026)).toBeUndefined();
    expect(yearsToFacts("-3", 2026)).toBe("-3");
    expect(yearsToFacts("ten", 2026)).toBe("ten");
    expect(yearsToFacts("200", 2026)).toBe("200");
    expect(yearsInput("-3", 2026)).toBe("-3");
  });
});

describe("opening hours", () => {
  it("groups days with the same times, in week order, and reads them back", () => {
    const rows = hoursToRows([]);
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => !r.open)).toBe(true);
    const weekdays = rows.map((r) => (["Saturday", "Sunday"].includes(r.day) ? r : { ...r, open: true }));
    weekdays[5] = { day: "Saturday", open: true, opens: "09:00", closes: "13:00" };
    const hours = rowsToHours(weekdays);
    expect(hours).toEqual([
      { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "08:00", closes: "17:00" },
      { days: ["Saturday"], opens: "09:00", closes: "13:00" },
    ]);
    expect(hoursToRows(hours)).toEqual(weekdays);
    expect(daysOfEntry(hours, 1)).toEqual(["Saturday"]);
  });
});

describe("path helpers", () => {
  it("reads and writes nested values without mutating, and removes a key set to undefined", () => {
    const facts = { location: { city: "Austin" }, services: [{ name: "A" }] };
    const next = setIn(facts, ["services", 1, "name"], "B");
    expect(next).toEqual({ location: { city: "Austin" }, services: [{ name: "A" }, { name: "B" }] });
    expect(facts.services).toHaveLength(1);
    expect(setIn(facts, ["location", "city"], undefined)).toEqual({ location: {}, services: [{ name: "A" }] });
    expect(getIn(next, ["services", 1, "name"])).toBe("B");
    expect(getIn(next, ["nope", 3])).toBeUndefined();
    expect(getIn({ a: 1 }, ["constructor"])).toBeUndefined();
  });

  it("makes field ids and moves list items", () => {
    expect(fieldId(["services", 0, "name"])).toBe("f-services-0-name");
    expect(moveItem(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });
});

describe("suggestSlug", () => {
  it.each([
    ["Joe's Plumbing & Drains", "joes-plumbing-drains"],
    ["  Café Déjà Vu  ", "cafe-deja-vu"],
    ["A".repeat(50), "a".repeat(40)],
    ["Twenty-Nine Characters Long Name Here!!", "twenty-nine-characters-long-name-here"],
    [undefined, ""],
  ])("%j -> %j", (name, slug) => {
    expect(suggestSlug(name)).toBe(slug);
  });
});

describe("altTextWarning", () => {
  it.each([
    ["IMG_1234.jpg", "This looks like a file name. Say what the photo shows instead."],
    ["DSC0042", "This looks like a file name. Say what the photo shows instead."],
    ["photo of a water heater", "No need to start with “photo”: say what the photo shows."],
    ["Image", "No need to start with “photo”: say what the photo shows."],
    ["New water heater installed in a garage", null],
    ["Photographer's van", null],
    ["", null],
  ])("%j", (alt, warning) => {
    expect(altTextWarning(alt)).toBe(warning);
  });
});
