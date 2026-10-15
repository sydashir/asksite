import { describe, expect, it } from "vitest";
import { formatUsd, formatUsdInput, MAX_PRICE_CENTS, parseUsdCents, priceErrors, priceRangeText } from "../../src/client/lib/money.ts";

// The examples are the shop contract's (§2.1) and draft C's (§4.9), so these tests run unchanged against lane A's parser
// when lib/money.ts becomes a re-export from @asksite/site-schema.

describe("parseUsdCents: accepted prices become whole cents", () => {
  it.each([
    ["89", 8900],
    ["9.9", 990],
    ["9.90", 990],
    ["$9.99", 999],
    ["$ 9.99", 999],
    ["1,299.50", 129_950],
    ["1,299", 129_900],
    [" 12 ", 1200],
    ["  12.5 ", 1250],
    ["9.", 900],
    [".99", 99],
    ["007.50", 750],
    ["100,000", 10_000_000],
    ["100000.00", 10_000_000],
  ])("%j is %d cents", (text, cents) => {
    expect(parseUsdCents(text)).toEqual({ ok: true, cents });
  });

  it("round-trips every cent value from 1 to 200,000 through the field text exactly (float traps like 29 cents included)", () => {
    for (let cents = 1; cents <= 200_000; cents += 1) {
      const parsed = parseUsdCents(formatUsdInput(cents));
      if (!parsed.ok || parsed.cents !== cents) throw new Error(`${cents} came back as ${JSON.stringify(parsed)}`);
    }
    expect(parseUsdCents(formatUsdInput(MAX_PRICE_CENTS))).toEqual({ ok: true, cents: MAX_PRICE_CENTS });
  });
});

describe("parseUsdCents: refused input names its problem", () => {
  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["9.999", "too_many_decimals"],
    ["-5", "negative"],
    ["−5", "negative"],
    ["$-5", "negative"],
    ["(5)", "negative"],
    ["12,50", "comma_decimal"],
    ["1,25", "comma_decimal"],
    ["€5", "other_currency"],
    ["£5", "other_currency"],
    ["¥5", "other_currency"],
    ["＄5", "other_currency"],
    ["5 USD", "other_currency"],
    ["0", "zero"],
    ["0.00", "zero"],
    ["$0", "zero"],
    ["100,000.01", "too_big"],
    ["9".repeat(25), "too_big"],
  ])("%j: %s", (text, problem) => {
    expect(parseUsdCents(text)).toEqual({ ok: false, problem });
  });

  it.each(["abc", "NaN", "Infinity", "1e3", "0x10", "0b1", "1_000", "+5", "5$", "１２", "１２.５０", "1,2500", ",250", "1,250,", "1,2,500", "9.9.9", "9 99", "."])(
    "%j is not a price",
    (text) => {
      expect(parseUsdCents(text)).toEqual({ ok: false, problem: "not_a_price" });
    },
  );

  it("honours a lower maximum", () => {
    expect(parseUsdCents("9", 900)).toEqual({ ok: true, cents: 900 });
    expect(parseUsdCents("9.01", 900)).toEqual({ ok: false, problem: "too_big" });
  });
});

describe("formatUsdInput and formatUsd: cents become text without rounding", () => {
  it.each([
    [1, "0.01", "$0.01", "$0.01"],
    [29, "0.29", "$0.29", "$0.29"],
    [990, "9.90", "$9.90", "$9.90"],
    [8900, "89", "$89", "$89.00"],
    [125_000, "1,250", "$1,250", "$1,250.00"],
    [129_950, "1,299.50", "$1,299.50", "$1,299.50"],
    [10_000_000, "100,000", "$100,000", "$100,000.00"],
  ])("%d cents: field %j, short %j, exact %j", (cents, input, short, exact) => {
    expect(formatUsdInput(cents)).toBe(input);
    expect(formatUsd(cents, "short")).toBe(short);
    expect(formatUsd(cents, "exact")).toBe(exact);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])("refuses %d: only whole, non-negative cents are money", (cents) => {
    expect(() => formatUsdInput(cents)).toThrow(RangeError);
    expect(() => formatUsd(cents, "exact")).toThrow(RangeError);
  });
});

describe("priceRangeText: one price, or the lowest of several", () => {
  it("shows one price when every choice costs the same", () => {
    expect(priceRangeText([990])).toBe("$9.90");
    expect(priceRangeText([8900, 8900])).toBe("$89");
  });

  it("shows the lowest with From when prices differ, wherever it sits", () => {
    expect(priceRangeText([990, 750])).toBe("From $7.50");
    expect(priceRangeText([750, 990, 1200])).toBe("From $7.50");
  });

  it("refuses an empty list", () => {
    expect(() => priceRangeText([])).toThrow(RangeError);
  });
});

describe("priceErrors: the field's words for each problem (draft C §4.8)", () => {
  it("says nothing for a good price, and nothing for an empty optional one", () => {
    expect(priceErrors("9.9", true)).toEqual([]);
    expect(priceErrors("", false)).toEqual([]);
  });

  it.each([
    ["", true, "Enter a price for this product."],
    ["abc", true, "Enter a price in dollars, like 89 or 9.99."],
    ["abc", false, "Enter a price in dollars, like 89 or 9.99, or leave it empty."],
    ["9.999", true, "Use at most 2 digits after the point, like 9.99."],
    ["12,50", true, "Use a point for cents, like 9.99."],
    ["-5", false, "A price can't be below zero."],
    ["€5", true, "Enter the price in US dollars, with or without the $ sign."],
    ["0", true, "Enter a price above $0."],
    ["0", false, "Enter a price above $0, or leave it empty."],
    ["200000", true, "Please enter a price of $100,000 or less."],
  ])("%j (required %s): %j", (text, required, message) => {
    expect(priceErrors(text, required)).toEqual([message]);
  });
});
