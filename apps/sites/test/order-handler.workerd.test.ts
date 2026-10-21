import { newId, ORDER_LIMITS } from "@asksite/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.ts";
import { handleOrder, type OrderOutcome, type ShopCatalog } from "../src/order.ts";
import { deriveOrderCookieKey, verifyOrderCookie } from "../src/order-cookie.ts";
import { cartQuote, priceCart } from "../src/pricing.ts";
import { at, ROOT, seedSite, sitesHarness, TEST_SECRETS, type SeededSite, type ToolsEnv } from "./support/harness.ts";

// POST /_o/<siteId> (pages lane proposal 1.6; strict tier: money, customer data). handleOrder returns what to answer as
// data; the router turns it into a page with Plan 3's cart-markup. These tests drive it with the real D1, R2 and rate
// limiter of the sites Worker, and a catalog given directly (the catalog reader is tested on its own).

const h = sitesHarness();
let sites: Env;
let tools: ToolsEnv;
beforeAll(async () => {
  ({ sites, tools } = await h.start());
}, 120_000);
afterAll(async () => {
  await h.server.close();
});

const PLAIN = newId();
const SIZED = newId();
const LARGE = newId();
const CATALOG: ShopCatalog = {
  v: 1, currency: "USD", checkout: "request", fulfilment: ["pickup", "delivery"], orderNote: "Pickup Tue-Sat",
  products: [
    { id: PLAIN, slug: "mom-flipflop", name: "Mom Flipflop", priceCents: 5000, soldOut: false, maxQty: 10 },
    { id: SIZED, slug: "sandal", name: "Sandal", priceCents: 1500, soldOut: false, maxQty: 10, variants: [{ id: LARGE, label: "Large", priceCents: 2499, soldOut: false }] },
  ],
};
const loadCatalog = async (_versionId: string): Promise<ShopCatalog | null> => CATALOG;

/** A live shop: its pointer names its live version, and its client order address is confirmed. */
async function shop(options: { confirmed?: boolean } = {}): Promise<SeededSite & { versionId: string }> {
  const site = await seedSite(tools, { metadata: { businessName: "Hip Hop Flip Flopp", phoneText: "(512) 555-0142", phoneTel: "+15125550142" } });
  if (options.confirmed ?? true) await tools.DB.prepare("UPDATE sites SET order_email = 'client@example.com', order_email_confirmed_at = 1 WHERE id = ?").bind(site.siteId).run();
  return { ...site, versionId: site.versionId ?? "" };
}

let ip = 0;
const lines = [{ productId: PLAIN, variantId: null, qty: 2 }, { productId: SIZED, variantId: LARGE, qty: 1 }];
const cartCookie = (siteId: string, cartId: string, cartLines = lines) =>
  `cart=${["1", siteId, cartId, ...cartLines.map((l) => `${l.productId}.${l.variantId ?? "-"}.${l.qty}`)].join("~")}`;
async function quoteOf(site: { siteId: string; versionId: string }, cartLines = lines): Promise<string> {
  return cartQuote(site.versionId, priceCart(CATALOG, { siteId: site.siteId, cartId: newId(), lines: cartLines }).lines);
}

const FIELDS = { name: "Dana Price", email: "dana@example.com", phone: "(512) 555-0199", fulfilment: "pickup", line1: "", line2: "", city: "", state: "", zip: "", note: "", website: "" };

interface Post { fields?: Record<string, string>; headers?: Record<string, string>; cookie?: string | null; ip?: string; body?: string; contentType?: string }

async function post(site: SeededSite & { versionId: string }, p: Post = {}, env: Env = sites, catalog = loadCatalog): Promise<OrderOutcome> {
  ip += 1;
  const cartId = newId();
  const headers: Record<string, string> = {
    "content-type": p.contentType ?? "application/x-www-form-urlencoded",
    origin: `https://${site.slug}.${ROOT}`,
    "cf-connecting-ip": p.ip ?? `198.51.${Math.floor(ip / 256) % 256}.${ip % 256}`,
    ...p.headers,
  };
  const cookie = p.cookie === undefined ? cartCookie(site.siteId, cartId) : p.cookie;
  if (cookie !== null) headers["cookie"] = cookie;
  const body = p.body ?? new URLSearchParams({ ...FIELDS, quote: await quoteOf(site), ...p.fields }).toString();
  const request = new Request(at(site.slug, `/_o/${site.siteId}`), { method: "POST", headers, body });
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (w: Promise<unknown>) => waits.push(w), passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const outcome = await handleOrder(request, env, ctx, { slug: site.slug, siteId: site.siteId, now: Date.now() }, { loadCatalog: catalog });
  await Promise.all(waits);
  return outcome;
}

const ordersOf = async (siteId: string) => (await tools.DB.prepare("SELECT * FROM orders WHERE site_id = ? ORDER BY number").bind(siteId).all<Record<string, unknown>>()).results;

describe("handleOrder: an order is placed", () => {
  it("stores the order priced from the catalog alone, answers 303 to the sent page with a signed order cookie, and clears the cart", async () => {
    const site = await shop();
    const outcome = await post(site);
    if (outcome.kind !== "placed") throw new Error(`expected placed, got ${outcome.kind}`);
    expect(outcome).toMatchObject({ kind: "placed", number: 1001, location: `/_o/${site.siteId}/sent/${outcome.orderId}`, emailPending: true });
    const [order] = await ordersOf(site.siteId);
    expect(order).toMatchObject({ id: outcome.orderId, subtotal_cents: 2 * 5000 + 2499, name: "Dana Price", email: "dana@example.com", phone: "+15125550199", fulfilment: "pickup", address_json: null, email_status: "pending" });
    expect(JSON.parse(String(order?.["items_json"])).map((l: { unitCents: number; qty: number }) => [l.unitCents, l.qty])).toEqual([[5000, 2], [2499, 1]]);
    const [orderCookie, clearCart] = outcome.setCookies;
    expect(clearCart).toBe("cart=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
    const value = /^order=([^;]+);/.exec(orderCookie ?? "")?.[1] ?? null;
    const key = await deriveOrderCookieKey(TEST_SECRETS.IP_HASH_KEY);
    expect(await verifyOrderCookie(key, value, { siteId: site.siteId, orderId: outcome.orderId, now: Date.now() })).toBe(true);
  });

  it("ignores any price, total or name the post carries: only the catalog prices", async () => {
    const site = await shop();
    const outcome = await post(site, { fields: { unitCents: "1", subtotal: "1", lineCents: "1", price: "0.01", productName: "Free" } });
    expect(outcome.kind).toBe("placed");
    expect((await ordersOf(site.siteId))[0]).toMatchObject({ subtotal_cents: 12499 });
  });

  it("stores a delivery order's address, and lands a second tap on the same order", async () => {
    const site = await shop();
    const cartId = newId();
    const fields = { fulfilment: "delivery", line1: "1 Main St", city: "Austin", state: "tx", zip: "78701" };
    const first = await post(site, { cookie: cartCookie(site.siteId, cartId), fields });
    const second = await post(site, { cookie: cartCookie(site.siteId, cartId), fields });
    if (first.kind !== "placed" || second.kind !== "placed") throw new Error("expected placed twice");
    expect(second.orderId).toBe(first.orderId);
    expect(await ordersOf(site.siteId)).toHaveLength(1);
    expect(JSON.parse(String((await ordersOf(site.siteId))[0]?.["address_json"]))).toEqual({ line1: "1 Main St", city: "Austin", state: "TX", zip: "78701" });
  });

  it("marks a note with more than 3 links as spam: stored, never emailed", async () => {
    const site = await shop();
    const outcome = await post(site, { fields: { note: "http://a http://b http://c http://d" } });
    expect(outcome).toMatchObject({ kind: "placed", emailPending: false });
    expect((await ordersOf(site.siteId))[0]).toMatchObject({ spam: 1, email_status: "skipped" });
  });
});

describe("handleOrder: the form comes back (nothing stored)", () => {
  it("re-shows the cart with the field errors and the buyer's values (never the honeypot or the quote), status 422", async () => {
    const site = await shop();
    const outcome = await post(site, { fields: { name: "", email: "dana@", website: "" } });
    if (outcome.kind !== "form") throw new Error(`expected form, got ${outcome.kind}`);
    expect(outcome.status).toBe(422);
    expect(outcome.slot.errors).toEqual([{ field: "name", code: "required" }, { field: "email", code: "email_invalid" }]);
    expect(outcome.slot.refill).toMatchObject({ email: "dana@", phone: "+15125550199", fulfilment: "pickup" });
    expect(Object.keys(outcome.slot.refill ?? {})).not.toContain("website");
    expect(Object.keys(outcome.slot.refill ?? {})).not.toContain("quote");
    expect(outcome.slot).toMatchObject({ siteId: site.siteId, subtotalCents: 12499, fulfilment: ["pickup", "delivery"], orderNote: "Pickup Tue-Sat", quote: await quoteOf(site) });
    expect(await ordersOf(site.siteId)).toEqual([]);
  });

  it("re-shows the cart (409, prices_changed) when the quote the buyer saw is not today's: no order at a price not seen", async () => {
    const site = await shop();
    const outcome = await post(site, { fields: { quote: "0".repeat(64) } });
    if (outcome.kind !== "form") throw new Error(`expected form, got ${outcome.kind}`);
    expect(outcome.status).toBe(409);
    expect(outcome.slot.notices).toEqual(["prices_changed"]);
    expect(outcome.slot.errors).toBeUndefined();
    expect(outcome.slot.refill).toMatchObject({ name: "Dana Price" });
    expect(await ordersOf(site.siteId)).toEqual([]);
  });

  it("re-shows the cart (409, items_removed) and rewrites the cookie when an item is no longer sold", async () => {
    const site = await shop();
    const gone = [...lines, { productId: newId(), variantId: null, qty: 1 }];
    const outcome = await post(site, { cookie: cartCookie(site.siteId, newId(), gone) });
    if (outcome.kind !== "form") throw new Error(`expected form, got ${outcome.kind}`);
    expect(outcome.slot.notices).toEqual(["items_removed"]);
    expect(outcome.slot.lines).toHaveLength(2);
    expect(outcome.setCart).toMatch(/^cart=1~/);
    expect(await ordersOf(site.siteId)).toEqual([]);
  });

  it("sends an empty or missing cart back to /cart", async () => {
    const site = await shop();
    expect((await post(site, { cookie: null })).kind).toBe("cart_empty");
    expect((await post(site, { cookie: cartCookie(site.siteId, newId(), []) })).kind).toBe("cart_empty");
  });
});

describe("handleOrder: refused (nothing stored)", () => {
  it("refuses a post from another tenant's page or with neither Origin nor Sec-Fetch-Site, before reading anything", async () => {
    const site = await shop();
    const other = await post(site, { headers: { origin: `https://someone-else.${ROOT}` } });
    expect(other).toMatchObject({ kind: "fixed", page: "forbidden" });
    const blind = await post(site, { headers: { origin: "" } });
    expect(blind).toMatchObject({ kind: "fixed", page: "forbidden" });
    expect(await ordersOf(site.siteId)).toEqual([]);
  });

  it("swallows a filled honeypot: no order, the plain sent page", async () => {
    const site = await shop();
    expect((await post(site, { fields: { website: "https://spam.example" } })).kind).toBe("honeypot");
    expect(await ordersOf(site.siteId)).toEqual([]);
  });

  it("answers 404 for a site id the host's pointer does not name, a malformed id, or a version without a catalog", async () => {
    const site = await shop();
    const other = await shop();
    expect(await post({ ...site, siteId: other.siteId })).toMatchObject({ kind: "fixed", page: "not_found" });
    expect(await post({ ...site, siteId: "nope" })).toMatchObject({ kind: "fixed", page: "not_found" });
    expect(await post(site, {}, sites, async () => null)).toMatchObject({ kind: "fixed", page: "not_found" });
  });

  it("never touches D1 for a site id the host's pointer does not name, or a version without a catalog (Decision 24)", async () => {
    const site = await shop();
    const other = await shop();
    const noD1 = { ...pick(sites), DB: new Proxy({}, { get: () => { throw new Error("D1 touched"); } }) } as unknown as Env;
    expect(await post({ ...site, siteId: other.siteId }, {}, noD1)).toMatchObject({ kind: "fixed", page: "not_found" });
    expect(await post(site, {}, noD1, async () => null)).toMatchObject({ kind: "fixed", page: "not_found" });
  });

  it("refuses a body that is not a form (415) or too large (413)", async () => {
    const site = await shop();
    expect(await post(site, { contentType: "application/json", body: "{}" })).toMatchObject({ kind: "fixed", page: "unsupported_media_type" });
    expect(await post(site, { body: "a=" + "x".repeat(17 * 1024) })).toMatchObject({ kind: "fixed", page: "too_large" });
  });

  it("refuses an order above ORDER_LIMITS.maxOrderCents (order_too_large)", async () => {
    const site = await shop();
    const big = { ...CATALOG, products: [{ ...CATALOG.products[0]!, priceCents: ORDER_LIMITS.maxOrderCents }] };
    const cart = [{ productId: PLAIN, variantId: null, qty: 2 }];
    const quote = await cartQuote(site.versionId, priceCart(big, { siteId: site.siteId, cartId: newId(), lines: cart }).lines);
    expect(await post(site, { cookie: cartCookie(site.siteId, newId(), cart), fields: { quote } }, sites, async () => big)).toMatchObject({ kind: "refusal", status: 422, reason: "order_too_large" });
  });

  it("refuses while orders are paused, without a confirmed client address, and past the network's daily cap", async () => {
    const paused = await shop();
    await tools.DB.prepare("UPDATE sites SET orders_paused_at = 1 WHERE id = ?").bind(paused.siteId).run();
    expect(await post(paused)).toMatchObject({ kind: "refusal", reason: "orders_paused", business: { name: "Hip Hop Flip Flopp", phone: "+15125550142" } });
    expect(await post(await shop({ confirmed: false }))).toMatchObject({ kind: "refusal", reason: "not_available" });
    const capped = await shop();
    // Five orders a day from one /48: each post comes from another /64 of 2001:db8:abcd::/48 and another cart.
    for (let i = 0; i < ORDER_LIMITS.perNetworkPerSitePerDay; i++) expect((await post(capped, { ip: `2001:db8:abcd:${i + 1}::1` })).kind).toBe("placed");
    expect(await post(capped, { ip: "2001:db8:abcd:ff::1" })).toMatchObject({ kind: "refusal", status: 429, reason: "daily_cap" });
  });

  it("brakes a burst from one network (ORDER_RL: 3 a minute) with rate_limited", async () => {
    const site = await shop();
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await post(site, { ip: "203.0.113.77" })).kind);
    expect(results.filter((k) => k === "refusal")).not.toHaveLength(0);
  });

  it("fails closed without IP_HASH_KEY: unavailable, nothing stored", async () => {
    const site = await shop();
    const env = { ...pick(sites), IP_HASH_KEY: "" } as Env;
    expect(await post(site, {}, env)).toMatchObject({ kind: "fixed", page: "unavailable" });
    expect(await ordersOf(site.siteId)).toEqual([]);
  });
});

describe("handleOrder: privacy", () => {
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, "log");
    error = vi.spyOn(console, "error");
    return () => {
      log.mockRestore();
      error.mockRestore();
    };
  });

  it("writes none of the buyer's values to the log, on an error re-show or a placed order", async () => {
    const site = await shop();
    const secret = { name: "Zelda Quux", email: "zelda.quux@example.com", phone: "(737) 555-0111", line1: "77 Secret Rd", city: "Hiddenville", note: "Back door code 4242" };
    await post(site, { fields: { ...secret, email: "zelda.quux@" } });
    await post(site, { fields: secret });
    const written = [...log.mock.calls, ...error.mock.calls].flat().map(String).join("\n");
    for (const value of ["Zelda", "Quux", "zelda.quux", "737", "5550111", "Secret Rd", "Hiddenville", "4242"]) expect(written).not.toContain(value);
  });
});

/** The Env's bindings and values by name, so a test can replace one (the harness's env is a proxy). */
function pick(env: Env): Record<string, unknown> {
  const names = ["DB", "LIVE", "MEDIA", "FORM_RL", "ORDER_RL", "SHOP_GET_RL", "ENVIRONMENT", "ROOT_DOMAIN", "MAILER", "MAIL_FROM", "SECURITY_TXT_EXPIRES", "LEAD_EMAILS_PER_DAY", "ORDER_EMAILS_PER_DAY", "RESEND_API_KEY", "IP_HASH_KEY"] as const;
  return Object.fromEntries(names.map((n) => [n, env[n]]));
}
