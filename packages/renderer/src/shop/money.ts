// Money for the shop. Every amount is an integer number of US cents and every sum is integer arithmetic, so no float
// ever reaches a price; anything that is not a whole, safe, non-negative amount throws instead of rendering a wrong
// price. formatUsd and jsonLdPrice mirror site-schema money.ts (shop contract §2.1); replaced by the import in phase 2.

const checkedCents = (cents: number): number => {
  if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents < 0) throw new Error(`Not an amount in whole cents: ${String(cents)}`);
  return cents;
};

/** Thousands grouped with ",": 1250 -> "1,250". */
const grouped = (whole: number): string => String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// mirrors site-schema money.ts §2.1; replaced by the import in phase 2
export const CURRENCY = "USD";

// mirrors site-schema money.ts §2.1 ($100,000.00, today's service cap); replaced by the import in phase 2
export const MAX_PRICE_CENTS = 10_000_000;

// mirrors site-schema money.ts §2.1; replaced by the import in phase 2
export type PriceStyle = "short" | "exact";

// mirrors site-schema money.ts §2.1; replaced by the import in phase 2
/**
 * "short" (site pages): "$89", "$9.90", "$1,250": whole amounts without cents, any other amount with two decimals
 * (never "$9.9"). "exact" (cart, order): always two decimals, "$89.00". Integer math only: no Intl, no division
 * that rounds. "short" equals today's service prices (format.ts formatPrice) for whole dollars.
 */
export function formatUsd(cents: number, style: PriceStyle): string {
  const rest = checkedCents(cents) % 100;
  const dollars = grouped((cents - rest) / 100);
  return style === "short" && rest === 0 ? `$${dollars}` : `$${dollars}.${String(rest).padStart(2, "0")}`;
}

// mirrors site-schema money.ts §2.1; replaced by the import in phase 2
/** schema.org price text: ASCII digits, "." as the point, two decimals, no symbol, no grouping: 8950 -> "89.50". */
export function jsonLdPrice(cents: number): string {
  const rest = checkedCents(cents) % 100;
  return `${(cents - rest) / 100}.${String(rest).padStart(2, "0")}`;
}

/** One cart line's amount: unit price times quantity, in cents. */
export function lineCents(unitCents: number, qty: number): number {
  if (!Number.isSafeInteger(qty) || qty < 1) throw new Error(`A quantity is a whole number of at least 1: ${String(qty)}`);
  const cents = checkedCents(unitCents) * qty;
  if (!Number.isSafeInteger(cents)) throw new Error("A line amount is too large");
  return cents;
}

/** The cart's subtotal in cents: the sum of its lines' amounts (never called a total: no tax or fees are computed). */
export function subtotalCents(lines: readonly { readonly unitCents: number; readonly qty: number }[]): number {
  const cents = lines.reduce((sum, line) => sum + lineCents(line.unitCents, line.qty), 0);
  if (!Number.isSafeInteger(cents)) throw new Error("A subtotal is too large");
  return cents;
}
