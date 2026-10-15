import { describe, expect, it } from "vitest";
import { addToCart, cartCookieName, clearCartCookie, emptyCart, parseCart, readCookie, removeFromCart, setCartCookie, setCartQty, CART_MAX_LINES, CART_MAX_QTY, type Cart } from "../src/cart.ts";

// The cart cookie (pages lane proposal 1.4): the site id, a random cart id and up to 20 lines of
// product id, variant id and quantity. Never a price, name or total: every view and order re-prices
// from the live catalog, so a tampered cookie can only change the buyer's own cart.

const SITE = "11111111-1111-4111-8111-111111111111";
const OTHER_SITE = "22222222-2222-4222-8222-222222222222";
const CART = "33333333-3333-4333-8333-333333333333";
const P1 = "44444444-4444-4444-8444-444444444444";
const P2 = "55555555-5555-4555-8555-555555555555";
const V1 = "66666666-6666-4666-8666-666666666666";

const cart = (lines: Cart["lines"]): Cart => ({ siteId: SITE, cartId: CART, lines });
const value = (...lines: string[]) => ["1", SITE, CART, ...lines].join("~");

describe("parseCart", () => {
  it("reads a cookie written by serialising a cart", () => {
    const c = cart([{ productId: P1, variantId: null, qty: 2 }, { productId: P2, variantId: V1, qty: 1 }]);
    expect(parseCart(value(`${P1}.-.2`, `${P2}.${V1}.1`), SITE)).toEqual(c);
  });

  it("reads an empty cart (no lines) as a cart with its id", () => {
    expect(parseCart(value(), SITE)).toEqual(cart([]));
  });

  it("is null for no cookie, another site's cookie, an unknown version or a malformed header", () => {
    expect(parseCart(null, SITE)).toBeNull();
    expect(parseCart("", SITE)).toBeNull();
    expect(parseCart(value(`${P1}.-.1`), OTHER_SITE)).toBeNull();
    expect(parseCart(["2", SITE, CART].join("~"), SITE)).toBeNull();
    expect(parseCart(["1", SITE, "not-an-id"].join("~"), SITE)).toBeNull();
    expect(parseCart(["1", "nope", CART].join("~"), SITE)).toBeNull();
  });

  it("drops lines that are not product id, variant id or '-', and a whole number 1 to 99", () => {
    const parsed = parseCart(value(`${P1}.-.0`, `${P1}.-.100`, `${P1}.-.1.5`, `${P1}.-.-1`, `${P1}.-.01`, "x.-.1", `${P1}.x.1`, `${P1}.-`, `${P2}.-.3`), SITE);
    expect(parsed).toEqual(cart([{ productId: P2, variantId: null, qty: 3 }]));
  });

  it("merges duplicate (product, variant) lines, adding quantities up to 99, so a duplicate line cannot dodge a quantity limit", () => {
    const parsed = parseCart(value(`${P1}.-.60`, `${P2}.${V1}.1`, `${P1}.-.60`, `${P1}.${V1}.2`), SITE);
    expect(parsed).toEqual(cart([
      { productId: P1, variantId: null, qty: CART_MAX_QTY },
      { productId: P2, variantId: V1, qty: 1 },
      { productId: P1, variantId: V1, qty: 2 },
    ]));
  });

  it("keeps at most 20 distinct lines", () => {
    const ids = Array.from({ length: 25 }, (_, i) => `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`);
    const parsed = parseCart(value(...ids.map((id) => `${id}.-.1`)), SITE);
    expect(parsed?.lines).toHaveLength(CART_MAX_LINES);
    expect(parsed?.lines.at(-1)?.productId).toBe(ids[19]);
  });
});

describe("cart changes", () => {
  it("starts an empty cart for a site with a fresh random cart id", () => {
    const a = emptyCart(SITE);
    const b = emptyCart(SITE);
    expect(a.siteId).toBe(SITE);
    expect(a.lines).toEqual([]);
    expect(a.cartId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.cartId).not.toBe(b.cartId);
  });

  it("adds to an existing line, up to 99", () => {
    const c = addToCart(cart([{ productId: P1, variantId: null, qty: 98 }]), P1, null, 5);
    expect(c).toEqual({ ok: true, cart: cart([{ productId: P1, variantId: null, qty: CART_MAX_QTY }]) });
  });

  it("adds a new line at the end, and refuses a 21st line", () => {
    const full = cart(Array.from({ length: CART_MAX_LINES }, (_, i) => ({ productId: `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`, variantId: null, qty: 1 })));
    expect(addToCart(cart([]), P1, V1, 2)).toEqual({ ok: true, cart: cart([{ productId: P1, variantId: V1, qty: 2 }]) });
    expect(addToCart(full, P2, null, 1)).toEqual({ ok: false, reason: "cart_full" });
  });

  it("sets a quantity, and removes the line at 0", () => {
    const c = cart([{ productId: P1, variantId: null, qty: 2 }, { productId: P2, variantId: V1, qty: 1 }]);
    expect(setCartQty(c, P2, V1, 7).lines).toEqual([{ productId: P1, variantId: null, qty: 2 }, { productId: P2, variantId: V1, qty: 7 }]);
    expect(setCartQty(c, P1, null, 0).lines).toEqual([{ productId: P2, variantId: V1, qty: 1 }]);
    expect(removeFromCart(c, P2, V1).lines).toEqual([{ productId: P1, variantId: null, qty: 2 }]);
  });
});

describe("the Set-Cookie strings (checked exactly: a browser silently drops a __Host- cookie with a wrong attribute)", () => {
  const c = cart([{ productId: P1, variantId: null, qty: 2 }]);

  it("on a real root: __Host-cart, Path=/, Secure, HttpOnly, SameSite=Lax, 30 days, no Domain", () => {
    expect(cartCookieName("asksite.example")).toBe("__Host-cart");
    expect(setCartCookie("asksite.example", c)).toBe(`__Host-cart=${value(`${P1}.-.2`)}; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax`);
    expect(clearCartCookie("asksite.example")).toBe("__Host-cart=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax");
  });

  it("on localhost (plain http in development): cart, without Secure", () => {
    expect(cartCookieName("localhost:8789")).toBe("cart");
    expect(setCartCookie("localhost:8789", c)).toBe(`cart=${value(`${P1}.-.2`)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`);
    expect(clearCartCookie("localhost:8789")).toBe("cart=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
  });

  it("a full cart stays under 4,096 bytes for name and value", () => {
    const full = cart(Array.from({ length: CART_MAX_LINES }, (_, i) => ({ productId: `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`, variantId: V1, qty: 99 })));
    const header = setCartCookie("asksite.example", full);
    expect(header.split(";")[0]!.length).toBeLessThan(4096);
  });
});

describe("readCookie", () => {
  it("finds a cookie by exact name among others", () => {
    expect(readCookie("a=1; __Host-cart=xyz; b=2", "__Host-cart")).toBe("xyz");
    expect(readCookie("x__Host-cart=no; __Host-cart=yes", "__Host-cart")).toBe("yes");
    expect(readCookie("a=1", "__Host-cart")).toBeNull();
    expect(readCookie(null, "__Host-cart")).toBeNull();
  });
});
