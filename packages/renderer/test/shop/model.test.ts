import { describe, expect, it } from "vitest";
import { shopUrl } from "../../src/html.ts";
import {
  DEFAULT_MAX_QTY,
  isBuyable,
  maxQtyOf,
  priceRangeCents,
  productForSlug,
  productPath,
  productPhotoAlt,
  productPhotoUrl,
  productsOf,
  variantLabel,
  variantPriceCents,
  type Product,
} from "../../src/shop/model.ts";
import { isProductSlug, isRecordId, orderActionPath } from "../../src/shop/paths.ts";

const ID = "6f1c1d7e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
const UPLOAD = "0b9a8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d";

const flipflop: Product = { id: ID, slug: "mom-filpflop", name: "Mom Filpflop", priceCents: 5000 };
const sized: Product = {
  id: "11111111-2222-4333-8444-555555555555",
  slug: "beach-tee",
  name: "Beach Tee",
  priceCents: 2400,
  options: [
    { name: "Size", values: ["S", "M"] },
    { name: "Colour", values: ["Blue", "Red"] },
  ],
  variants: [
    { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", values: ["S", "Blue"] },
    { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1", values: ["M", "Blue"], priceCents: 2800, soldOut: true },
    { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2", values: ["M", "Red"], priceCents: 2600 },
  ],
};

describe("the mirrored shop helpers (shop contract §2.3)", () => {
  it("productsOf: [] when absent, the list in display order otherwise", () => {
    expect(productsOf({})).toEqual([]);
    expect(productsOf({ products: [sized, flipflop] })).toEqual([sized, flipflop]);
  });

  it("productForSlug finds by slug only", () => {
    expect(productForSlug({ products: [flipflop, sized] }, "beach-tee")).toBe(sized);
    expect(productForSlug({ products: [flipflop] }, "nope")).toBeUndefined();
    expect(productForSlug({}, "mom-filpflop")).toBeUndefined();
  });

  it("productPath is /shop/<slug>", () => {
    expect(productPath(flipflop)).toBe("/shop/mom-filpflop");
  });

  it("variantLabel joins the values in option order", () => {
    expect(sized.variants?.map((v) => variantLabel(sized, v))).toEqual(["S / Blue", "M / Blue", "M / Red"]);
  });

  it("variantPriceCents: the variant's own price, else the product's", () => {
    expect(sized.variants?.map((v) => variantPriceCents(sized, v))).toEqual([2400, 2800, 2600]);
  });

  it("isBuyable: not sold out, and with variants at least one variant not sold out", () => {
    expect(isBuyable(flipflop)).toBe(true);
    expect(isBuyable({ ...flipflop, soldOut: true })).toBe(false);
    expect(isBuyable(sized)).toBe(true);
    expect(isBuyable({ ...sized, variants: (sized.variants ?? []).map((v) => ({ ...v, soldOut: true as const })) })).toBe(false);
    expect(isBuyable({ ...sized, soldOut: true })).toBe(false);
  });

  it("priceRangeCents: the product's price without variants, the variants' prices with them", () => {
    expect(priceRangeCents(flipflop)).toEqual({ low: 5000, high: 5000 });
    expect(priceRangeCents(sized)).toEqual({ low: 2400, high: 2800 });
  });

  it("productPhotoAlt: the owner's alt, else the name, then '<name>, photo N'", () => {
    const p: Product = { ...flipflop, photos: [{ upload: UPLOAD, width: 800, height: 600 }, { upload: UPLOAD, width: 800, height: 600 }, { upload: UPLOAD, width: 1, height: 1, alt: "Side view" }] };
    expect([0, 1, 2].map((i) => productPhotoAlt(p, i))).toEqual(["Mom Filpflop", "Mom Filpflop, photo 2", "Side view"]);
  });

  it("productPhotoUrl follows core's mediaUrl (keys.ts:15)", () => {
    expect(productPhotoUrl("https://media.asksite.example/" + ID + "/", { upload: UPLOAD, width: 1, height: 1 })).toBe(`https://media.asksite.example/${ID}/${UPLOAD}.webp`);
  });

  it("maxQtyOf: the product's own cap, else DEFAULT_MAX_QTY (provisional 10)", () => {
    expect(DEFAULT_MAX_QTY).toBe(10);
    expect(maxQtyOf(flipflop)).toBe(10);
    expect(maxQtyOf({ ...flipflop, maxQty: 3 })).toBe(3);
  });
});

describe("shop paths and shopUrl()", () => {
  it("mints the shop's links and endpoints", () => {
    expect(String(shopUrl("shop"))).toBe("/shop");
    expect(String(shopUrl("cart"))).toBe("/cart");
    expect(String(shopUrl("cartAction"))).toBe("/_cart");
    expect(String(shopUrl({ product: "mom-filpflop" }))).toBe("/shop/mom-filpflop");
    expect(String(shopUrl({ order: ID }))).toBe(`/_o/${ID}`);
  });

  it.each(["", "-a", "a-", "a--b", "A", "a/b", "../cart", "a b", "a".repeat(51), "javascript:alert(1)", "%2e%2e"])("refuses the product slug %j", (slug) => {
    expect(isProductSlug(slug)).toBe(false);
    expect(() => shopUrl({ product: slug })).toThrow("Invalid product slug");
  });

  it("accepts the contract's slugs up to 50 characters", () => {
    for (const slug of ["a", "0", "mom-filpflop", "a1-b2-c3", "a".repeat(50)]) expect(isProductSlug(slug)).toBe(true);
  });

  it.each(["", "x", ID.toUpperCase(), `${ID}/sent`, "6f1c1d7e-2b3a-1c5d-8e9f-0a1b2c3d4e5f", "../../x"])("refuses the site id %j", (id) => {
    expect(isRecordId(id)).toBe(false);
    expect(() => orderActionPath(id)).toThrow("Invalid site id");
    expect(() => shopUrl({ order: id })).toThrow("Invalid site id");
  });

  it("refuses anything that is not a shop target", () => {
    expect(() => shopUrl("/cart" as never)).toThrow("Invalid shop link");
    expect(() => shopUrl({ path: "/x" } as never)).toThrow("Invalid shop link");
  });
});
