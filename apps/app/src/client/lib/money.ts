// Prices in whole US cents, with no floating-point arithmetic anywhere.
//
// TEMPORARY: `parseUsdCents`, `formatUsd`, `formatUsdInput` and `MAX_PRICE_CENTS` mirror the shop contract (§2.1) until lane A's
// contract commit lands them in packages/site-schema/src/money.ts. Then this block becomes one re-export from "@asksite/site-schema"
// and test/client/money.test.ts runs against lane A's code unchanged. The texts below are this lane's (draft C §4.8 wording).

export const MAX_PRICE_CENTS = 10_000_000;

export type PriceProblem = "empty" | "not_a_price" | "too_many_decimals" | "comma_decimal" | "negative" | "other_currency" | "zero" | "too_big";
export type ParsedPrice = { ok: true; cents: number } | { ok: false; problem: PriceProblem };

/** Dollars (plain, or grouped with commas) and up to two digits of cents; "9." and ".99" are prices. */
const PRICE = /^(?:(\d{1,3}(?:,\d{3})+)|(\d+))?(?:\.(\d*))?$/;
/** More dollar digits than this is over any limit: stop before Number() could lose precision. */
const MAX_DOLLAR_DIGITS = 9;

export function parseUsdCents(input: string, maxCents: number = MAX_PRICE_CENTS): ParsedPrice {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed === "$") return { ok: false, problem: "empty" };
  if (/^\$?\s*[-−(]/.test(trimmed)) return { ok: false, problem: "negative" };
  if (/[€£¥₹＄￥]|^[A-Za-z]{3}\s*\d|\d\s*[A-Za-z]{3}$/.test(trimmed)) return { ok: false, problem: "other_currency" };
  const plain = trimmed.replace(/^\$\s*/, "");
  if (/^\d+,\d{1,2}$/.test(plain)) return { ok: false, problem: "comma_decimal" };
  const match = PRICE.exec(plain);
  if (match === null) return { ok: false, problem: "not_a_price" };
  const dollars = (match[1] ?? match[2] ?? "").replace(/,/g, "").replace(/^0+(?=\d)/, "");
  const cents = match[3] ?? "";
  if (dollars === "" && cents === "") return { ok: false, problem: "not_a_price" };
  if (cents.length > 2) return { ok: false, problem: "too_many_decimals" };
  if (dollars.length > MAX_DOLLAR_DIGITS) return { ok: false, problem: "too_big" };
  const total = Number(dollars === "" ? "0" : dollars) * 100 + Number(cents.padEnd(2, "0"));
  if (total === 0) return { ok: false, problem: "zero" };
  if (total > maxCents) return { ok: false, problem: "too_big" };
  return { ok: true, cents: total };
}

function assertCents(cents: number): void {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError(`Not a whole number of cents: ${cents}`);
}

const grouped = (dollars: number) => String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The field after the owner leaves it: "9.90", "1,299.50", and "89" for whole dollars. */
export function formatUsdInput(cents: number): string {
  assertCents(cents);
  const rest = cents % 100;
  return rest === 0 ? grouped(cents / 100) : `${grouped(Math.trunc(cents / 100))}.${String(rest).padStart(2, "0")}`;
}

/** "short" (site pages, lists): "$89", "$9.90", "$1,250". "exact" (orders, carts): "$89.00". */
export function formatUsd(cents: number, style: "short" | "exact"): string {
  assertCents(cents);
  const input = formatUsdInput(cents);
  return style === "exact" && cents % 100 === 0 ? `$${input}.00` : `$${input}`;
}

// ---- This lane's code from here (not part of the contract) ----

/** One price, or the lowest of several different ones: "$9.90", "From $7.50". */
export function priceRangeText(prices: readonly number[]): string {
  if (prices.length === 0) throw new RangeError("No prices");
  const lowest = Math.min(...prices);
  const text = formatUsd(lowest, "short");
  return prices.every((p) => p === lowest) ? text : `From ${text}`;
}

/**
 * What a price field says about what was typed (draft C §4.8 wording; NEW texts, for approval). A required price (a product's)
 * asks for one when empty; an optional one (a size's own price, a "was" price) may stay empty.
 */
export function priceErrors(text: string, required: boolean, maxCents: number = MAX_PRICE_CENTS): string[] {
  const parsed = parseUsdCents(text, maxCents);
  if (parsed.ok) return [];
  switch (parsed.problem) {
    case "empty":
      return required ? ["Enter a price for this product."] : [];
    case "not_a_price":
      return [required ? "Enter a price in dollars, like 89 or 9.99." : "Enter a price in dollars, like 89 or 9.99, or leave it empty."];
    case "too_many_decimals":
      return ["Use at most 2 digits after the point, like 9.99."];
    case "comma_decimal":
      return ["Use a point for cents, like 9.99."];
    case "negative":
      return ["A price can't be below zero."];
    case "other_currency":
      return ["Enter the price in US dollars, with or without the $ sign."];
    case "zero":
      return [required ? "Enter a price above $0." : "Enter a price above $0, or leave it empty."];
    case "too_big":
      return [`Please enter a price of ${formatUsd(maxCents, "short")} or less.`];
  }
}
