// The product screens' own rules, kept out of the components so they are tested on their own: the typed lists of sizes or
// colors, one row for every combination of them (which ones are sold, at what price), the product's link, and the words a
// product's state is shown in.

// TEMPORARY: the shop contract's limits and fulfilment list (§2.3, §2.4) until lane A's contract commit exports them from
// @asksite/site-schema (PRODUCT_LIMITS, FULFILMENT); then these become re-exports.
export const PRODUCT_LIMITS = { products: 24, photos: 6, options: 2, optionValues: 10, variants: 20, name: 120, description: 1000, alt: 125, maxQty: 99 } as const;
export const OPTION_TEXT_MAX = 20;
export const FULFILMENT = ["pickup", "delivery", "shipping"] as const;
export type Fulfilment = (typeof FULFILMENT)[number];

/** One list of choices, e.g. { name: "Size", values: ["6", "7", "8"] }. */
export interface ProductOptionDraft {
  name: string;
  values: string[];
}

/**
 * One combination of choices ("Size 7", "Size 7, Color Red"). Only offered rows become the product's variants (the contract's
 * explicit list: a combination that is not offered cannot be bought). An empty price means the product's price. `id` is null
 * until the container gives a new row its id.
 */
export interface VariantDraft {
  id: string | null;
  values: string[];
  offered: boolean;
  priceText: string;
  compareAtText: string;
  soldOut: boolean;
}

/** A product photo: an upload of this site (its id), the URL to show it, and its optional description. */
export interface ProductPhotoDraft {
  upload: string;
  url: string;
  alt: string;
}

/** The product as the form holds it: typed text for every number (the container parses it), so nothing typed is lost. */
export interface ProductDraft {
  name: string;
  slug: string;
  priceText: string;
  compareAtText: string;
  description: string;
  soldOut: boolean;
  maxQtyText: string;
  photos: ProductPhotoDraft[];
  options: ProductOptionDraft[];
  variants: VariantDraft[];
}

/** Paths name the product's own fields: ["name"], ["photos", 0, "alt"], ["options", 1, "values"], ["variants", 3, "price"]. */
export type ProductPath = ReadonlyArray<string | number>;

export interface OptionLimits {
  maxValues: number;
  maxLength: number;
}

export const OPTION_LIMITS: OptionLimits = { maxValues: PRODUCT_LIMITS.optionValues, maxLength: OPTION_TEXT_MAX };

export interface AddedValues {
  values: string[];
  /** What the owner should hear: why anything was left out. */
  problems: string[];
  added: string[];
}

/**
 * Adds what the owner typed to a list: one value, or several separated by commas ("6, 7, 8"). Blank parts are skipped; a value
 * already in the list (in any letter case) is left out and named; so is one that is too long, or one past the limit.
 */
export function addOptionValues(values: readonly string[], typed: string, limits: OptionLimits = OPTION_LIMITS): AddedValues {
  const next = [...values];
  const problems: string[] = [];
  const added: string[] = [];
  for (const part of typed.split(",")) {
    const value = part.trim().replace(/\s+/g, " ");
    if (value === "") continue;
    if ([...value].length > limits.maxLength) problems.push(`“${value}” is too long. Keep each one to ${limits.maxLength} characters.`);
    else if (next.some((v) => v.toLowerCase() === value.toLowerCase())) problems.push(`“${value}” is already in the list.`);
    else if (next.length >= limits.maxValues) problems.push(`“${value}” was not added: the list holds up to ${limits.maxValues}.`);
    else {
      next.push(value);
      added.push(value);
    }
  }
  return { values: next, problems, added };
}

/** The sentence for what was just added: "Added 6.", "Added 6 and 7.", "Added 6, 7 and 8." */
export function addedText(added: readonly string[]): string {
  if (added.length === 0) return "";
  const last = added[added.length - 1]!;
  return added.length === 1 ? `Added ${last}.` : `Added ${added.slice(0, -1).join(", ")} and ${last}.`;
}

/** Every combination of the options that have values, in the order the owner typed them. */
export function combinations(options: readonly ProductOptionDraft[]): string[][] {
  const lists = options.map((option) => option.values).filter((values) => values.length > 0);
  if (lists.length === 0) return [];
  return lists.reduce<string[][]>((rows, values) => rows.flatMap((row) => values.map((value) => [...row, value])), [[]]);
}

const sameValues = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * The rows for the current options: a combination that already had a row keeps it (its id, price, "was" price, sold-out and
 * offered marks); a new one starts offered, at the product's price, in stock. Rows for combinations that no longer exist go.
 */
export function syncVariants(options: readonly ProductOptionDraft[], variants: readonly VariantDraft[]): VariantDraft[] {
  return combinations(options).map(
    (values) => variants.find((variant) => sameValues(variant.values, values)) ?? { id: null, values, offered: true, priceText: "", compareAtText: "", soldOut: false },
  );
}

/** The rows' problem, if more combinations are offered than a product may have. */
export function variantsProblem(variants: readonly VariantDraft[], max: number = PRODUCT_LIMITS.variants): string | null {
  const offered = variants.filter((v) => v.offered).length;
  return offered > max ? `${offered} choices are offered; a product can have up to ${max}. Uncheck the ones the shop doesn't sell, or remove some sizes or colors.` : null;
}

/** How a combination is named on screen and to screen readers: "Size 7", "Size 7, Color Red". */
export function choiceName(options: readonly ProductOptionDraft[], values: readonly string[]): string {
  const named = options.filter((option) => option.values.length > 0);
  return values.map((value, i) => `${named[i]?.name.trim() || "Option"} ${value}`).join(", ");
}

/** The contract's product link rule: lower-case letters, numbers and single dashes, 1 to 50 characters. */
export const PRODUCT_SLUG = /^(?:[a-z0-9]|[a-z0-9](?:[a-z0-9]|-(?!-)){0,48}[a-z0-9])$/;

/** A product link made from its name: "Mom Flipflop, extra soft!" becomes "mom-flipflop-extra-soft". Accents lose their marks. */
export function slugFromName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return slug === "" ? "product" : slug;
}

/** What the product list needs for one row. Prices are the prices of what can be bought, in cents. */
export interface ProductSummary {
  id: string;
  name: string;
  photoUrl: string | null;
  prices: number[];
  /** The choices in one line, e.g. "Sizes 6, 7, 8" (null when the product has none). */
  choicesText: string | null;
  soldOut: boolean;
  /** The sold-out combinations by name, e.g. ["Size 8"]. */
  soldOutChoices: string[];
}

export interface StatusWord {
  text: string;
  tone: "brand" | "neutral";
}

/** The product's state in words (never color alone): sold out, partly sold out, or on sale. */
export function productStatus(product: Pick<ProductSummary, "soldOut" | "soldOutChoices">): StatusWord[] {
  if (product.soldOut) return [{ text: "Sold out", tone: "neutral" }];
  const partly = product.soldOutChoices.length;
  if (partly === 0) return [{ text: "On sale", tone: "brand" }];
  return [
    { text: "On sale", tone: "brand" },
    { text: partly === 1 ? `${product.soldOutChoices[0]} sold out` : `${partly} choices sold out`, tone: "neutral" },
  ];
}

export const FULFILMENT_LABEL: Record<Fulfilment, { label: string; hint: string }> = {
  pickup: { label: "Pickup", hint: "Buyers collect their order." },
  delivery: { label: "Local delivery", hint: "The business brings it to the buyer." },
  shipping: { label: "Shipping", hint: "Sent by post or courier." },
};
