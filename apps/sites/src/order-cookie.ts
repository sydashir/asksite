import { isId } from "@asksite/core";
import { isLocal } from "./headers.ts";

// The order cookie (pages lane proposal 1.6 step 10; moderator ruling 2026-10-21). The "order received" page shows an
// order's details only to the browser that placed it, and it checks this cookie BEFORE any D1 read, so a crafted request
// costs no D1 read. The value is `<orderId>.<expiresAt>.<MAC>`: HMAC-SHA256 over the site, the order and the expiry, under
// a key derived with HKDF-SHA256 from IP_HASH_KEY with the fixed label ORDER_COOKIE_LABEL. IP_HASH_KEY itself is never the
// MAC key. Rotating IP_HASH_KEY therefore also ends every order cookie in use (runbook). With no key, nothing is trusted.
// Workers' Web Crypto supports HKDF (importKey, deriveKey) and HMAC (sign, verify)
// (developers.cloudflare.com/workers/runtime-apis/web-crypto/, checked 2026-10-21).

export const ORDER_COOKIE_LABEL = "asksite/order-cookie/v1";
/** One day, in seconds: long enough to come back to the page, short enough to keep it private. */
const MAX_AGE = 86_400;
const MAC_BYTES = 32;

const encoder = new TextEncoder();

/** The MAC key, or null when there is no secret (the page then shows only its generic text). */
export async function deriveOrderCookieKey(secret: string | undefined, label: string = ORDER_COOKIE_LABEL): Promise<CryptoKey | null> {
  if (secret === undefined || secret === "") return null;
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(label) },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

const signed = (siteId: string, orderId: string, expiresAt: number) => encoder.encode(`v1|${siteId}|${orderId}|${expiresAt}`);

const toBase64Url = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function signOrderCookie(key: CryptoKey, input: { siteId: string; orderId: string; expiresAt: number }): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", key, signed(input.siteId, input.orderId, input.expiresAt));
  return `${input.orderId}.${input.expiresAt}.${toBase64Url(mac)}`;
}

/** True only for an unexpired cookie this key made for exactly this site and order (constant-time check by crypto.subtle.verify). */
export async function verifyOrderCookie(
  key: CryptoKey | null,
  value: string | null,
  expected: { siteId: string; orderId: string; now: number },
): Promise<boolean> {
  if (key === null || value === null) return false;
  const [orderId = "", expiry = "", macText = "", ...extra] = value.split(".");
  if (extra.length > 0 || !isId(orderId) || orderId !== expected.orderId || !/^\d{1,15}$/.test(expiry)) return false;
  const expiresAt = Number(expiry);
  if (expected.now >= expiresAt) return false;
  const mac = fromBase64Url(macText);
  if (mac === null || mac.byteLength !== MAC_BYTES) return false;
  return crypto.subtle.verify("HMAC", key, mac, signed(expected.siteId, orderId, expiresAt));
}

/** `__Host-order` on a real root (bound to this one host, as the cart); plain `order` without Secure on localhost. */
export const orderCookieName = (root: string): string => (isLocal(root) ? "order" : "__Host-order");

export const setOrderCookie = (root: string, value: string): string =>
  `${orderCookieName(root)}=${value}; Path=/; Max-Age=${MAX_AGE}; ${isLocal(root) ? "" : "Secure; "}HttpOnly; SameSite=Lax`;

/** How long the cookie (and the MAC inside it) stays valid, in ms. */
export const ORDER_COOKIE_TTL_MS = MAX_AGE * 1000;
