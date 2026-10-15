// The shop's data, mirrored from the APPROVED shop contract (asksite-plan4 .superpowers/phase2/shop-contract.md
// §2.3-2.4, 2026-10-15) until lane A's contract commit adds the real types to site-schema. Each declaration below
// mirrors site-schema shop.ts §2.3 (or §2.4); phase 2 replaces it by the import, so the names, shapes and helper
// signatures must stay exactly the contract's. Builders may ADD a renderer-local helper elsewhere (shop/markup.ts),
// never here. Every value is typed by staff from what the client gave: the renderer never invents a product fact.

// mirrors site-schema shop.ts §2.3; replaced by the import in phase 2
export const PRODUCT_LIMITS = { products: 24, photos: 6, options: 2, optionValues: 10, variants: 20, name: 120, description: 1000, alt: 125, maxQty: 99 } as const;

// mirrors site-schema shop.ts §2.3 (shop-contract §3: "DEFAULT_MAX_QTY: proposed 10"; §9 Q4 is still open, so this
// value is PROVISIONAL); replaced by the import in phase 2
export const DEFAULT_MAX_QTY = 10;

// mirrors site-schema shop.ts §2.4; replaced by the import in phase 2
export const FULFILMENT = ["pickup", "delivery", "shipping"] as const;
export type Fulfilment = (typeof FULFILMENT)[number];

// mirrors site-schema shop.ts §2.3; replaced by the import in phase 2
/** A product photo is an upload of this site; its URL is productPhotoUrl(mediaBase, photo). */
export interface ProductPhoto {
  /** uploads.id (a v4 UUID). */
  readonly upload: string;
  readonly width: number;
  readonly height: number;
  /** Absent = "<name>", "<name>, photo 2" (productPhotoAlt). */
  readonly alt?: string;
}

// mirrors site-schema shop.ts §2.3; replaced by the import in phase 2
/** "Size" with ["S", "M", "L"]; "Colour" with ["Blue", "Red"]. */
export interface ProductOption {
  readonly name: string;
  readonly values: readonly string[];
}

// mirrors site-schema shop.ts §2.3; replaced by the import in phase 2
/** One buyable combination (combinations not listed cannot be bought). Cart lines name its id. */
export interface ProductVariant {
  readonly id: string;
  /** One value per option, in option order. */
  readonly values: readonly string[];
  /** Absent = the product's price. */
  readonly priceCents?: number;
  /** The client's former price for this variant (FTC 16 CFR 233.1, contract §2.5). */
  readonly compareAtCents?: number;
  /** Absent = available (unless the product is sold out). */
  readonly soldOut?: true;
}

// mirrors site-schema shop.ts §2.3; replaced by the import in phase 2
export interface Product {
  /** Stable, never reused: the cart, orders and catalog name it. */
  readonly id: string;
  /** Unique per site: /shop/<slug>. */
  readonly slug: string;
  /** 1-120. */
  readonly name: string;
  /** Paragraphs, at most 1000. */
  readonly description?: string;
  readonly priceCents: number;
  /** The client's typed former price, above priceCents (contract §2.5); the only source of "Was $X". */
  readonly compareAtCents?: number;
  readonly soldOut?: true;
  /** 1-99; absent = DEFAULT_MAX_QTY. */
  readonly maxQty?: number;
  /** 1..6, the first is the main one; absent = the renderer's placeholder. */
  readonly photos?: readonly ProductPhoto[];
  /** 1..2; present exactly when variants are. */
  readonly options?: readonly ProductOption[];
  /** 1..20. */
  readonly variants?: readonly ProductVariant[];
}

// mirrors site-schema shop.ts §2.4; replaced by the import in phase 2
export interface ShopSettings {
  /** 1..3, unique, in FULFILMENT order. */
  readonly fulfilment: readonly Fulfilment[];
  /** Shown on the cart and in the order email, as typed. */
  readonly orderNote?: string;
  /** The client's returns/exchanges policy, shown as typed. */
  readonly returns?: string;
  /** The client's sizing advice, shown as typed. */
  readonly sizing?: string;
  readonly formerPricesConfirmed?: true;
}

// mirrors the two new optional Facts keys (contract §2.3-2.4: Facts += { products?, shop? }); replaced by Facts in phase 2
export interface ShopFacts {
  readonly products?: readonly Product[];
  readonly shop?: ShopSettings;
}

// mirrors site-schema shop.ts §2.3 helpers; replaced by the import in phase 2

/** The site's products in display order; [] when it has none. */
export const productsOf = (facts: ShopFacts): readonly Product[] => facts.products ?? [];

export const productForSlug = (facts: ShopFacts, slug: string): Product | undefined => productsOf(facts).find((p) => p.slug === slug);

/** "/shop/<slug>". */
export const productPath = (p: { readonly slug: string }): `/shop/${string}` => `/shop/${p.slug}`;

/** The variant's values in option order: "M / Blue". */
export const variantLabel = (_p: Product, v: ProductVariant): string => v.values.join(" / ");

/** The variant's own price, or the product's. */
export const variantPriceCents = (p: Product, v: ProductVariant): number => v.priceCents ?? p.priceCents;

/** Not sold out, and when it has variants, at least one variant not sold out. */
export const isBuyable = (p: Product): boolean => p.soldOut !== true && (p.variants === undefined || p.variants.some((v) => v.soldOut !== true));

/** The lowest and highest price over the product and its variants (with variants, the variants' prices only). */
export function priceRangeCents(p: Product): { low: number; high: number } {
  const prices = p.variants === undefined ? [p.priceCents] : p.variants.map((v) => variantPriceCents(p, v));
  return { low: Math.min(...prices), high: Math.max(...prices) };
}

/** The photo's alt text: the owner's, or "<name>" for the first photo and "<name>, photo 2" for the second. */
export function productPhotoAlt(p: Product, i: number): string {
  const alt = p.photos?.[i]?.alt;
  if (alt !== undefined) return alt;
  return i === 0 ? p.name : `${p.name}, photo ${i + 1}`;
}

/**
 * The photo's URL: mediaBase ("https://media.<root>/<siteId>/") followed by the upload's file, as core's
 * mediaUrl() names it (packages/core/src/keys.ts:15: `https://media.${root}/${siteId}/${uploadId}.webp`).
 */
export const productPhotoUrl = (mediaBase: string, photo: ProductPhoto): string => `${mediaBase}${photo.upload}.webp`;

/** The most of this product one cart may hold: its own maxQty, or DEFAULT_MAX_QTY. */
export const maxQtyOf = (p: Product): number => p.maxQty ?? DEFAULT_MAX_QTY;
