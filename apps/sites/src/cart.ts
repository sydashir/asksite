import { isId, newId } from "@asksite/core";
import { isLocal } from "./headers.ts";

// The shop's cart, kept in one cookie (pages lane proposal 1.4): the site id, a random cart id and up to
// CART_MAX_LINES lines of product id, variant id and quantity. Never a price, name or total: every cart view and
// every order re-prices the lines from the live version's approved catalog, so a tampered cookie can only change
// the buyer's own cart. The value is `1~<siteId>~<cartId>~<productId>.<variantId or ->.<qty>~…`: ids are v4 UUIDs,
// so it needs no encoding.

export const CART_MAX_LINES = 20;
export const CART_MAX_QTY = 99;
/** 30 days, in seconds. */
const CART_MAX_AGE = 2_592_000;
const VERSION = "1";
const QTY = /^[1-9]\d?$/;

export interface CartLine {
  productId: string;
  variantId: string | null;
  qty: number;
}

export interface Cart {
  siteId: string;
  cartId: string;
  lines: CartLine[];
}

const sameItem = (line: CartLine, productId: string, variantId: string | null) => line.productId === productId && line.variantId === variantId;

/**
 * The cart in a cookie value, or null when there is none to use: no value, another version, another site's cart,
 * or a damaged header. A line that is not two ids (or an id and "-") and a whole quantity 1 to 99 is dropped;
 * repeats of one (product, variant) are merged, their quantities added up to CART_MAX_QTY, so no quantity limit
 * applied per line can be dodged by repeating the line; past CART_MAX_LINES distinct lines the rest are dropped.
 */
export function parseCart(value: string | null, siteId: string): Cart | null {
  const [version, cookieSite, cartId, ...raw] = (value ?? "").split("~");
  if (version !== VERSION || cookieSite !== siteId || cartId === undefined || !isId(cookieSite) || !isId(cartId)) return null;
  const lines: CartLine[] = [];
  for (const entry of raw) {
    const [productId = "", variant = "", qty = "", ...extra] = entry.split(".");
    if (extra.length > 0 || !isId(productId) || (variant !== "-" && !isId(variant)) || !QTY.test(qty)) continue;
    const variantId = variant === "-" ? null : variant;
    const same = lines.find((line) => sameItem(line, productId, variantId));
    if (same !== undefined) same.qty = Math.min(CART_MAX_QTY, same.qty + Number(qty));
    else if (lines.length < CART_MAX_LINES) lines.push({ productId, variantId, qty: Number(qty) });
  }
  return { siteId, cartId, lines };
}

const serialise = (cart: Cart): string =>
  [VERSION, cart.siteId, cart.cartId, ...cart.lines.map((l) => `${l.productId}.${l.variantId ?? "-"}.${l.qty}`)].join("~");

/** A new, empty cart for the site, with a fresh random id. */
export const emptyCart = (siteId: string): Cart => ({ siteId, cartId: newId(), lines: [] });

/** Adds `qty` of an item: to its line (up to CART_MAX_QTY) or as a new last line, refused past CART_MAX_LINES. */
export function addToCart(cart: Cart, productId: string, variantId: string | null, qty: number): { ok: true; cart: Cart } | { ok: false; reason: "cart_full" } {
  const lines = cart.lines.map((line) => (sameItem(line, productId, variantId) ? { ...line, qty: Math.min(CART_MAX_QTY, line.qty + qty) } : line));
  if (lines.some((line) => sameItem(line, productId, variantId))) return { ok: true, cart: { ...cart, lines } };
  if (lines.length >= CART_MAX_LINES) return { ok: false, reason: "cart_full" };
  return { ok: true, cart: { ...cart, lines: [...lines, { productId, variantId, qty: Math.min(CART_MAX_QTY, qty) }] } };
}

/** Sets an item's quantity; 0 removes its line. */
export function setCartQty(cart: Cart, productId: string, variantId: string | null, qty: number): Cart {
  if (qty <= 0) return removeFromCart(cart, productId, variantId);
  return { ...cart, lines: cart.lines.map((line) => (sameItem(line, productId, variantId) ? { ...line, qty: Math.min(CART_MAX_QTY, qty) } : line)) };
}

export const removeFromCart = (cart: Cart, productId: string, variantId: string | null): Cart => ({
  ...cart,
  lines: cart.lines.filter((line) => !sameItem(line, productId, variantId)),
});

/**
 * `__Host-cart` binds the cookie to this one host: Secure, Path=/ and no Domain, so no other customer site (all of
 * them share the root) and not app.<root> ever receives it. Local development is plain http, where a Secure cookie
 * is not kept, so there it is plain `cart` without Secure (the same exemption as HSTS, headers.ts isLocal).
 */
export const cartCookieName = (root: string): string => (isLocal(root) ? "cart" : "__Host-cart");

const attributes = (root: string, maxAge: number): string => `Path=/; Max-Age=${maxAge}; ${isLocal(root) ? "" : "Secure; "}HttpOnly; SameSite=Lax`;

/** The Set-Cookie value that stores `cart` for 30 days. Lax, not Strict: a buyer coming back by a link still has it. */
export const setCartCookie = (root: string, cart: Cart): string => `${cartCookieName(root)}=${serialise(cart)}; ${attributes(root, CART_MAX_AGE)}`;

/** The Set-Cookie value that deletes the cart (after an order). */
export const clearCartCookie = (root: string): string => `${cartCookieName(root)}=; ${attributes(root, 0)}`;

/** The value of the cookie named exactly `name` in a Cookie header, or null. */
export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
