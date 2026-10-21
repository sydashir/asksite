import { describe, expect, it } from "vitest";
import { deriveOrderCookieKey, ORDER_COOKIE_LABEL, orderCookieName, setOrderCookie, signOrderCookie, verifyOrderCookie } from "../src/order-cookie.ts";

// The order cookie (pages lane proposal 1.6 step 10, review I4; moderator ruling 2026-10-21): the "order received" page
// shows an order's details only to the browser that placed it, and checks that BEFORE any D1 read, so crafted requests
// never reach D1. The value is `<orderId>.<expiresAt>.<MAC>`; the MAC is HMAC-SHA256 over the site, order and expiry,
// under a key derived with HKDF-SHA256 from IP_HASH_KEY with a fixed label (never IP_HASH_KEY itself), and is checked with
// crypto.subtle.verify. No key: no cookie is trusted (fail closed).

const SECRET = "test-only-ip-hash-key";
const SITE = "11111111-1111-4111-8111-111111111111";
const OTHER_SITE = "22222222-2222-4222-8222-222222222222";
const ORDER = "33333333-3333-4333-8333-333333333333";
const OTHER_ORDER = "44444444-4444-4444-8444-444444444444";
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const DAY = 86_400_000;

describe("signOrderCookie / verifyOrderCookie", () => {
  it("accepts its own cookie for that site and order until it expires", async () => {
    const key = await deriveOrderCookieKey(SECRET);
    const value = await signOrderCookie(key!, { siteId: SITE, orderId: ORDER, expiresAt: NOW + DAY });
    expect(value).toMatch(new RegExp(`^${ORDER}\\.${NOW + DAY}\\.[A-Za-z0-9_-]{43}$`));
    expect(await verifyOrderCookie(key, value, { siteId: SITE, orderId: ORDER, now: NOW })).toBe(true);
    expect(await verifyOrderCookie(key, value, { siteId: SITE, orderId: ORDER, now: NOW + DAY - 1 })).toBe(true);
  });

  it("refuses it once expired", async () => {
    const key = await deriveOrderCookieKey(SECRET);
    const value = await signOrderCookie(key!, { siteId: SITE, orderId: ORDER, expiresAt: NOW + DAY });
    expect(await verifyOrderCookie(key, value, { siteId: SITE, orderId: ORDER, now: NOW + DAY })).toBe(false);
  });

  it("refuses it for another order or another site", async () => {
    const key = await deriveOrderCookieKey(SECRET);
    const value = await signOrderCookie(key!, { siteId: SITE, orderId: ORDER, expiresAt: NOW + DAY });
    expect(await verifyOrderCookie(key, value, { siteId: SITE, orderId: OTHER_ORDER, now: NOW })).toBe(false);
    expect(await verifyOrderCookie(key, value, { siteId: OTHER_SITE, orderId: ORDER, now: NOW })).toBe(false);
  });

  it("refuses any tampering: the order id, the expiry, or the MAC", async () => {
    const key = await deriveOrderCookieKey(SECRET);
    const value = await signOrderCookie(key!, { siteId: SITE, orderId: ORDER, expiresAt: NOW + DAY });
    const [, , mac] = value.split(".") as [string, string, string];
    const flipped = mac.slice(0, -1) + (mac.endsWith("A") ? "B" : "A");
    expect(await verifyOrderCookie(key, `${OTHER_ORDER}.${NOW + DAY}.${mac}`, { siteId: SITE, orderId: OTHER_ORDER, now: NOW })).toBe(false);
    expect(await verifyOrderCookie(key, `${ORDER}.${NOW + 10 * DAY}.${mac}`, { siteId: SITE, orderId: ORDER, now: NOW })).toBe(false);
    expect(await verifyOrderCookie(key, `${ORDER}.${NOW + DAY}.${flipped}`, { siteId: SITE, orderId: ORDER, now: NOW })).toBe(false);
  });

  it("refuses a cookie made under another label, or from another secret", async () => {
    const value = await signOrderCookie((await deriveOrderCookieKey(SECRET, "asksite/other/v1"))!, { siteId: SITE, orderId: ORDER, expiresAt: NOW + DAY });
    expect(await verifyOrderCookie(await deriveOrderCookieKey(SECRET), value, { siteId: SITE, orderId: ORDER, now: NOW })).toBe(false);
    const other = await signOrderCookie((await deriveOrderCookieKey("another-secret"))!, { siteId: SITE, orderId: ORDER, expiresAt: NOW + DAY });
    expect(await verifyOrderCookie(await deriveOrderCookieKey(SECRET), other, { siteId: SITE, orderId: ORDER, now: NOW })).toBe(false);
    expect(ORDER_COOKIE_LABEL).toBe("asksite/order-cookie/v1");
  });

  it("never uses IP_HASH_KEY itself as the MAC key: a MAC made with the raw secret is refused", async () => {
    const raw = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const good = await signOrderCookie((await deriveOrderCookieKey(SECRET))!, { siteId: SITE, orderId: ORDER, expiresAt: NOW + DAY });
    const [, , goodMac] = good.split(".") as [string, string, string];
    // The same payload the module signs, MACed under the raw secret: it must not match the derived key's MAC.
    const payload = new TextEncoder().encode(`v1|${SITE}|${ORDER}|${NOW + DAY}`);
    const rawMac = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", raw, payload)))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    expect(rawMac).not.toBe(goodMac);
    expect(await verifyOrderCookie(await deriveOrderCookieKey(SECRET), `${ORDER}.${NOW + DAY}.${rawMac}`, { siteId: SITE, orderId: ORDER, now: NOW })).toBe(false);
  });

  it("fails closed without a key: no key is derived from an empty or missing secret, and nothing verifies", async () => {
    expect(await deriveOrderCookieKey("")).toBeNull();
    expect(await deriveOrderCookieKey(undefined)).toBeNull();
    const value = await signOrderCookie((await deriveOrderCookieKey(SECRET))!, { siteId: SITE, orderId: ORDER, expiresAt: NOW + DAY });
    expect(await verifyOrderCookie(null, value, { siteId: SITE, orderId: ORDER, now: NOW })).toBe(false);
  });

  it("refuses malformed values without throwing", async () => {
    const key = await deriveOrderCookieKey(SECRET);
    for (const bad of [null, "", "x", `${ORDER}`, `${ORDER}.abc.mac`, `${ORDER}.${NOW + DAY}`, `${ORDER}.${NOW + DAY}.!!!`, `${ORDER}.${NOW + DAY}.mac.extra`, `not-an-id.${NOW + DAY}.mac`]) {
      expect(await verifyOrderCookie(key, bad, { siteId: SITE, orderId: ORDER, now: NOW }), String(bad)).toBe(false);
    }
  });
});

describe("the order cookie's Set-Cookie string", () => {
  it("on a real root: __Host-order, Path=/, 1 day, Secure, HttpOnly, SameSite=Lax", () => {
    expect(orderCookieName("asksite.example")).toBe("__Host-order");
    expect(setOrderCookie("asksite.example", "v")).toBe("__Host-order=v; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax");
  });

  it("on localhost: order, without Secure", () => {
    expect(orderCookieName("localhost:8789")).toBe("order");
    expect(setOrderCookie("localhost:8789", "v")).toBe("order=v; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax");
  });
});
