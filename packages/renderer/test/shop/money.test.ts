import { describe, expect, it } from "vitest";
import { formatPrice } from "../../src/format.ts";
import { formatUsd, jsonLdPrice, lineCents, subtotalCents } from "../../src/shop/money.ts";

describe("formatUsd (mirrors site-schema money.ts, shop contract §2.1)", () => {
  it.each([
    [8900, "$89", "$89.00"],
    [990, "$9.90", "$9.90"],
    [999, "$9.99", "$9.99"],
    [125000, "$1,250", "$1,250.00"],
    [129950, "$1,299.50", "$1,299.50"],
    [5000, "$50", "$50.00"],
    [4950, "$49.50", "$49.50"],
    [1, "$0.01", "$0.01"],
    [99, "$0.99", "$0.99"],
    [100, "$1", "$1.00"],
    [10_000_000, "$100,000", "$100,000.00"],
    [123_456_789_01, "$123,456,789.01", "$123,456,789.01"],
    [0, "$0", "$0.00"],
  ])("%i cents: short %s, exact %s", (cents, short, exact) => {
    expect(formatUsd(cents, "short")).toBe(short);
    expect(formatUsd(cents, "exact")).toBe(exact);
  });

  it("never writes one decimal ($9.9) or a float artefact (29 cents is $0.29)", () => {
    for (let cents = 0; cents <= 200_000; cents++) {
      const text = formatUsd(cents, "short");
      expect(text).toMatch(/^\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?$/);
      expect(formatUsd(cents, "exact")).toMatch(/^\$\d{1,3}(?:,\d{3})*\.\d{2}$/);
    }
    expect(formatUsd(29, "exact")).toBe("$0.29");
    expect(formatUsd(57, "short")).toBe("$0.57");
  });

  it("equals today's service price text (format.ts formatPrice) for every whole-dollar amount up to the service cap", () => {
    for (const dollars of [1, 9, 50, 89, 999, 1000, 1250, 99_999, 100_000]) expect(formatUsd(dollars * 100, "short")).toBe(formatPrice(dollars));
  });

  it.each([-1, 1.5, 0.1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "5000" as unknown as number])("refuses %s", (cents) => {
    expect(() => formatUsd(cents, "short")).toThrow("Not an amount in whole cents");
    expect(() => formatUsd(cents, "exact")).toThrow("Not an amount in whole cents");
  });
});

describe("jsonLdPrice (schema.org price text)", () => {
  it.each([
    [8950, "89.50"],
    [8900, "89.00"],
    [125000, "1250.00"],
    [1, "0.01"],
    [10_000_000, "100000.00"],
  ])("%i -> %s", (cents, text) => {
    expect(jsonLdPrice(cents)).toBe(text);
  });

  it("refuses a fractional or negative amount", () => {
    expect(() => jsonLdPrice(89.5)).toThrow();
    expect(() => jsonLdPrice(-100)).toThrow();
  });
});

describe("cart arithmetic: integer cents only", () => {
  it("prices a line as unit times quantity", () => {
    expect(lineCents(5000, 3)).toBe(15000);
    expect(lineCents(1999, 7)).toBe(13993);
  });

  it("sums a subtotal exactly where floats would drift (0.1 + 0.2)", () => {
    expect(subtotalCents([{ unitCents: 10, qty: 1 }, { unitCents: 20, qty: 1 }])).toBe(30);
    expect(subtotalCents([{ unitCents: 1999, qty: 3 }, { unitCents: 4950, qty: 2 }, { unitCents: 1, qty: 99 }])).toBe(5997 + 9900 + 99);
    expect(subtotalCents([])).toBe(0);
  });

  it("refuses a bad quantity, a fractional price and an unsafe sum", () => {
    expect(() => lineCents(5000, 0)).toThrow("quantity");
    expect(() => lineCents(5000, 1.5)).toThrow("quantity");
    expect(() => lineCents(50.5, 1)).toThrow("whole cents");
    expect(() => lineCents(2 ** 52, 4)).toThrow("too large");
    expect(() => subtotalCents([{ unitCents: 2 ** 52, qty: 1 }, { unitCents: 2 ** 52, qty: 1 }])).toThrow("too large");
  });
});
