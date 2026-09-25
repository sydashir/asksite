import { describe, expect, it } from "vitest";
import { tokenCount } from "../src/providers/shared.ts";

// P3-11 (l): a token count is usable only if it is a finite integer from 0 to 10,000,000. NaN and Infinity cannot
// come from a JSON body (JSON has no such values; 1e400 parses to Infinity), so they are tested here directly.
describe("tokenCount (P3-11 l)", () => {
  it.each([0, 1, 2900, 10_000_000])("keeps %s", (value) => {
    expect(tokenCount(value)).toBe(value);
  });

  it.each([
    ["-1", -1],
    ["1.5", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["1e308", 1e308],
    ["10,000,001", 10_000_001],
    ['the string "12"', "12"],
    ["null", null],
    ["undefined", undefined],
    ["true", true],
    ["an object", { value: 12 }],
  ])("refuses %s", (_name, value) => {
    expect(tokenCount(value)).toBeUndefined();
  });
});
