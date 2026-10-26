import { describe, expect, it } from "vitest";
import type { Cart } from "../src/cart.ts";
import { cartQuote, priceCart, type PricingCatalog } from "../src/pricing.ts";

// Price integrity (pages lane proposal 1.5, strict tier): a cart is priced from the live version's approved catalog
// alone. The cookie names items and quantities; every price, name and total comes from the catalog.

const SITE = "11111111-1111-4111-8111-111111111111";
const VERSION = "22222222-2222-4222-8222-222222222222";
const CART = "33333333-3333-4333-8333-333333333333";
const PLAIN = "44444444-4444-4444-8444-444444444444";
const SIZED = "55555555-5555-4555-8555-555555555555";
const GONE = "56565656-5656-4565-8565-565656565656";
const SOLD = "57575757-5757-4575-8575-575757575757";
const SMALL = "66666666-6666-4666-8666-666666666666";
const LARGE = "77777777-7777-4777-8777-777777777777";
const OUT = "78787878-7878-4787-8787-787878787878";

// The shape of site-schema's Catalog (shop contract §3): resolved values only. A product always has its base price;
// `variants`, when present, means a variant must be chosen and carries each variant's resolved price.
const CATALOG: PricingCatalog = {
  products: [
    { id: PLAIN, slug: "mom-flipflop", name: "Mom Flipflop", priceCents: 5000, compareAtCents: 6000, soldOut: false, maxQty: 3 },
    { id: SIZED, slug: "sandal", name: "Sandal", priceCents: 1500, soldOut: false, maxQty: 99, variants: [
      { id: SMALL, label: "Small", priceCents: 1999, soldOut: false },
      { id: LARGE, label: "Large", priceCents: 2499, compareAtCents: 2999, soldOut: false },
      { id: OUT, label: "Huge", priceCents: 2999, soldOut: true },
    ] },
    { id: SOLD, slug: "sold", name: "Sold", priceCents: 100, soldOut: true, maxQty: 99 },
  ],
};
const cart = (lines: Cart["lines"]): Cart => ({ siteId: SITE, cartId: CART, lines });

describe("priceCart", () => {
  it("prices every line from the catalog: the product's price, or the chosen variant's", () => {
    const priced = priceCart(CATALOG, cart([{ productId: PLAIN, variantId: null, qty: 2 }, { productId: SIZED, variantId: LARGE, qty: 3 }]));
    expect(priced.lines).toEqual([
      { productId: PLAIN, variantId: null, slug: "mom-flipflop", name: "Mom Flipflop", variantLabel: null, unitCents: 5000, compareAtCents: 6000, qty: 2, maxQty: 3, lineCents: 10000 },
      { productId: SIZED, variantId: LARGE, slug: "sandal", name: "Sandal", variantLabel: "Large", unitCents: 2499, compareAtCents: 2999, qty: 3, maxQty: 99, lineCents: 7497 },
    ]);
    expect(priced.subtotalCents).toBe(17497);
    expect(priced.changed).toBe(false);
  });

  it("takes the compare-at price of the chosen variant only (never the product's for a variant)", () => {
    const priced = priceCart(CATALOG, cart([{ productId: SIZED, variantId: SMALL, qty: 1 }]));
    expect(priced.lines[0]?.compareAtCents).toBeNull();
  });

  it("never falls back to the base price: a product with variants needs a real, available variant, and a plain product takes none", () => {
    const priced = priceCart(CATALOG, cart([
      { productId: SIZED, variantId: null, qty: 1 },
      { productId: SIZED, variantId: "88888888-8888-4888-8888-888888888888", qty: 1 },
      { productId: SIZED, variantId: OUT, qty: 1 },
      { productId: PLAIN, variantId: SMALL, qty: 1 },
    ]));
    expect(priced.lines).toEqual([]);
    expect(priced.subtotalCents).toBe(0);
    expect(priced.changed).toBe(true);
  });

  it("drops unknown and sold-out products and says the cart changed", () => {
    const priced = priceCart(CATALOG, cart([{ productId: GONE, variantId: null, qty: 1 }, { productId: SOLD, variantId: null, qty: 1 }, { productId: PLAIN, variantId: null, qty: 1 }]));
    expect(priced.lines.map((l) => l.productId)).toEqual([PLAIN]);
    expect(priced.changed).toBe(true);
    expect(priced.cart.lines).toEqual([{ productId: PLAIN, variantId: null, qty: 1 }]);
  });

  it("lowers a quantity above the product's maxQty to maxQty and says the cart changed", () => {
    const priced = priceCart(CATALOG, cart([{ productId: PLAIN, variantId: null, qty: 99 }]));
    expect(priced.lines[0]).toMatchObject({ qty: 3, lineCents: 15000 });
    expect(priced.changed).toBe(true);
    expect(priced.cart.lines).toEqual([{ productId: PLAIN, variantId: null, qty: 3 }]);
  });

  it("gives an empty cart a zero subtotal", () => {
    expect(priceCart(CATALOG, cart([]))).toEqual({ lines: [], subtotalCents: 0, changed: false, cart: cart([]) });
  });
});

describe("cartQuote (what the buyer saw)", () => {
  const lines = priceCart(CATALOG, cart([{ productId: PLAIN, variantId: null, qty: 2 }, { productId: SIZED, variantId: SMALL, qty: 1 }])).lines;

  it("is the same for the same version and lines, as lower-case hex SHA-256", async () => {
    const a = await cartQuote(VERSION, lines);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await cartQuote(VERSION, lines)).toBe(a);
  });

  it("changes with the version, any unit price, any quantity, any item and the order of the lines", async () => {
    const a = await cartQuote(VERSION, lines);
    const [first, second] = lines as [(typeof lines)[0], (typeof lines)[0]];
    expect(await cartQuote("99999999-9999-4999-8999-999999999999", lines)).not.toBe(a);
    expect(await cartQuote(VERSION, [{ ...first, unitCents: 4999 }, second])).not.toBe(a);
    expect(await cartQuote(VERSION, [{ ...first, qty: 3 }, second])).not.toBe(a);
    expect(await cartQuote(VERSION, [first, { ...second, variantId: LARGE }])).not.toBe(a);
    expect(await cartQuote(VERSION, [second, first])).not.toBe(a);
  });
});
