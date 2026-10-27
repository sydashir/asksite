// Shop test data and contexts, shared by the shop tests and the preview script (.superpowers/phase2/shop/preview.ts).
// The boss's one real product ("Mom Filpflop", 5000 cents, no photos, no options) plus four SAMPLE products made up
// for tests and screenshots only (they are not any client's data): one with photos, one with a former price, one with
// sizes and colours (one combination sold out), and one sold out.
import type { SiteDocumentInput } from "@asksite/site-schema";
import type { ShopRenderContext } from "../../src/shop/design.ts";
import type { ShopPage, ShopState } from "../../src/context.ts";
import type { Product, ShopSettings } from "../../src/shop/model.ts";
import { makeContext } from "../support/doc.ts";

/** A site id (a v4 record id), the media base built from it, and upload ids for the sample photos. */
export const SITE_ID = "5d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6";
export const MEDIA_BASE = `https://media.asksite.example/${SITE_ID}/`;
export const UPLOADS = ["0b9a8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c61", "0b9a8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c62", "0b9a8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c63"] as const;

/** The boss's product, as he typed it (his "service" Mom Filpflop at $50), with no photo and no options. */
export const BOSS_PRODUCT: Product = { id: "6f1c1d7e-2b3a-4c5d-8e9f-0a1b2c3d4e5f", slug: "mom-filpflop", name: "Mom Filpflop", priceCents: 5000 };

/** SAMPLE: three photos. */
export const WITH_PHOTOS: Product = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "canvas-beach-tote",
  name: "Canvas Beach Tote",
  description: "A roomy canvas tote with two inside pockets.\n\nWipe clean with a damp cloth.",
  priceCents: 3400,
  photos: [
    { upload: UPLOADS[0], width: 800, height: 1000 },
    { upload: UPLOADS[1], width: 800, height: 800, alt: "The tote's inside pockets" },
    { upload: UPLOADS[2], width: 800, height: 800 },
  ],
};

/** SAMPLE: a typed, attested former price ("Was"). */
export const ON_SALE: Product = { id: "22222222-2222-4222-8222-222222222222", slug: "straw-sun-hat", name: "Straw Sun Hat", priceCents: 2800, compareAtCents: 3600 };

/** SAMPLE: sizes and colours; prices differ; one combination sold out; the cart allows 4. */
export const WITH_VARIANTS: Product = {
  id: "33333333-3333-4333-8333-333333333333",
  slug: "everyday-slide",
  name: "Everyday Slide",
  priceCents: 4200,
  maxQty: 4,
  options: [
    { name: "Size", values: ["7", "8", "9"] },
    { name: "Colour", values: ["Sand", "Navy"] },
  ],
  variants: [
    { id: "33333333-3333-4333-8333-333333333301", values: ["7", "Sand"] },
    { id: "33333333-3333-4333-8333-333333333302", values: ["8", "Sand"] },
    { id: "33333333-3333-4333-8333-333333333303", values: ["9", "Sand"], soldOut: true },
    { id: "33333333-3333-4333-8333-333333333304", values: ["8", "Navy"], priceCents: 4600 },
    { id: "33333333-3333-4333-8333-333333333305", values: ["9", "Navy"], priceCents: 4600, compareAtCents: 5200 },
  ],
};

/** SAMPLE: sold out. */
export const SOLD_OUT: Product = { id: "44444444-4444-4444-8444-444444444444", slug: "kids-flip-flop", name: "Kids Flip Flop", priceCents: 2400, soldOut: true };

/** The preview's list: the boss's product first, then the samples. */
export const PREVIEW_PRODUCTS: readonly Product[] = [BOSS_PRODUCT, WITH_PHOTOS, ON_SALE, WITH_VARIANTS, SOLD_OUT];

/** Settings with former prices attested (contract §2.5), so "Was" may show. */
export const SETTINGS: ShopSettings = { fulfilment: ["pickup", "shipping"], formerPricesConfirmed: true };

/** A shop state for tests. */
export function shopState(products: readonly Product[], settings: ShopSettings | undefined = SETTINGS, shopFirst = true): ShopState {
  return { products, settings, mediaBase: MEDIA_BASE, shopFirst };
}

/** A shop context on a page of the document (Home unless told), as a shop page when `shopPage` is given. */
export function shopContext(doc: SiteDocumentInput, state: ShopState, shopPage?: ShopPage): ShopRenderContext {
  const base = makeContext(doc);
  return { ...base, shop: state, ...(shopPage === undefined ? {} : { shopPage }) };
}
