import { newId, ORDER_LIMITS } from "@asksite/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertOrder, type NewOrder } from "../src/order-sql.ts";
import { writesReturnNoRows } from "./support/d1.ts";
import { seedSite, sitesHarness, type SeededSite, type ToolsEnv } from "./support/harness.ts";

// insertOrder (pages lane proposal 1.6 step 9, strict tier: customer data and caps): ONE statement stores the order
// only while the site is live on the priced version, not paused, has a confirmed client order address, the cart is
// not a repeat, and the network's and the site's caps for the UTC day allow it; the same statement numbers the order
// and decides its email (spam skipped; the global and per-site email budgets). A read-back in the same batch says why
// nothing was stored. Production D1 returns no rows for writes (A10), so every call here goes through that wrapper.

const NOON = Date.UTC(2026, 9, 15, 12, 0, 0);
const DAY_MS = 86_400_000;
const EMAILS_PER_DAY = 20;
/** The global budget is per UTC day across all sites; tests other than the budget test pass this one so it never bites. */
const NO_GLOBAL_CAP = 1_000_000;

const h = sitesHarness();
let tools: ToolsEnv;
let db: D1Database;
beforeAll(async () => {
  ({ tools } = await h.start());
  db = writesReturnNoRows(tools.DB);
}, 120_000);
afterAll(async () => {
  await h.server.close();
});

/** A live site whose client order address is confirmed, unless told otherwise. */
async function shopSite(options: { confirmed?: boolean } = {}): Promise<SeededSite & { versionId: string }> {
  const site = await seedSite(tools);
  if (options.confirmed ?? true) {
    await tools.DB.prepare("UPDATE sites SET order_email = 'client@example.com', order_email_confirmed_at = 1 WHERE id = ?").bind(site.siteId).run();
  }
  return { ...site, versionId: site.versionId ?? "" };
}

const LINE = { productId: newId(), variantId: null, slug: "mom-flipflop", name: "Mom Flipflop", variantLabel: null, unitCents: 5000, compareAtCents: null, qty: 1, maxQty: 10, lineCents: 5000 };

function order(site: { siteId: string; versionId: string }, over: Partial<NewOrder> = {}): NewOrder {
  return {
    orderId: newId(), siteId: site.siteId, versionId: site.versionId, now: NOON,
    buyer: { name: "Dana Price", phone: "(512) 555-0199", email: "dana@example.com", fulfilment: "pickup", address: null, note: null },
    items: [LINE], subtotalCents: 5000, cartId: newId(), cartHash: newId(), spam: false, ipHash: newId(), netHash: newId(),
    emailsPerDay: NO_GLOBAL_CAP, ...over,
  };
}

/** Stores `count` orders directly, as the Worker would have stored them. */
async function fill(siteId: string, count: number, row: { createdAt?: number; netHash?: string; status?: string; error?: string | null; spam?: 0 | 1 } = {}): Promise<void> {
  const start = (await tools.DB.prepare("SELECT COALESCE(MAX(number), 1000) AS n FROM orders WHERE site_id = ?").bind(siteId).first<{ n: number }>())?.n ?? 1000;
  await tools.DB.batch(
    Array.from({ length: count }, (_, i) =>
      tools.DB.prepare(
        `INSERT INTO orders (id, site_id, number, version_id, created_at, name, phone, email, fulfilment, items_json, subtotal_cents, cart_id, cart_hash, spam, email_status, email_error, ip_hash, net_hash)
         VALUES (?, ?, ?, ?, ?, 'n', 'p', 'e@example.com', 'pickup', '[]', 100, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(newId(), siteId, start + i + 1, newId(), row.createdAt ?? NOON, newId(), newId(), row.spam ?? 0, row.status ?? "sent", row.error ?? null, newId(), row.netHash ?? newId()),
    ),
  );
}

/** Stored, whatever its email: the site's email slice may be used up by the rows a test filled ('sent' by default). */
const isStored = (result: { outcome: string }) => result.outcome === "pending" || result.outcome === "failed";

const stored = (orderId: string) => tools.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first<Record<string, unknown>>();

describe("insertOrder: storing", () => {
  it("stores a valid order as pending, numbered 1001, with exactly the priced snapshot", async () => {
    const site = await shopSite();
    const input = order(site, { buyer: { name: "Dana Price", phone: "(512) 555-0199", email: "dana@example.com", fulfilment: "delivery", address: { line1: "1 Main St", city: "Austin", state: "TX", zip: "78701" }, note: "Gate code 12" } });
    expect(await insertOrder(db, input)).toEqual({ outcome: "pending", orderId: input.orderId, number: 1001 });
    expect(await stored(input.orderId)).toMatchObject({
      site_id: site.siteId, number: 1001, version_id: site.versionId, created_at: NOON, name: "Dana Price", phone: "(512) 555-0199", email: "dana@example.com",
      fulfilment: "delivery", address_json: JSON.stringify({ line1: "1 Main St", city: "Austin", state: "TX", zip: "78701" }), note: "Gate code 12",
      items_json: JSON.stringify([LINE]), subtotal_cents: 5000, currency: "usd", cart_id: input.cartId, cart_hash: input.cartHash, status: "new", spam: 0,
      email_status: "pending", email_error: null, ip_hash: input.ipHash, net_hash: input.netHash,
    });
  });

  it("numbers each site's orders on from 1001, separately per site", async () => {
    const one = await shopSite();
    const two = await shopSite();
    expect((await insertOrder(db, order(one))).outcome).toBe("pending");
    expect(await insertOrder(db, order(one))).toMatchObject({ number: 1002 });
    expect(await insertOrder(db, order(two))).toMatchObject({ number: 1001 });
  });

  it("stores a spam order as skipped, never counted for email", async () => {
    const site = await shopSite();
    const input = order(site, { spam: true });
    expect(await insertOrder(db, input)).toEqual({ outcome: "skipped", orderId: input.orderId, number: 1001 });
    expect(await stored(input.orderId)).toMatchObject({ spam: 1, email_status: "skipped", email_error: null });
  });
});

describe("insertOrder: the repeat check (a second tap on Place order)", () => {
  it("answers duplicate with the first order's id and number for the same cart and contents within the window, storing nothing", async () => {
    const site = await shopSite();
    const first = order(site);
    await insertOrder(db, first);
    const again = order(site, { cartId: first.cartId, cartHash: first.cartHash, ipHash: newId(), netHash: newId(), now: NOON + ORDER_LIMITS.repeatWindowMs - 1 });
    expect(await insertOrder(db, again)).toEqual({ outcome: "duplicate", orderId: first.orderId, number: 1001 });
    expect(await stored(again.orderId)).toBeNull();
  });

  it("stores a new order when the cart's contents changed, or once the window has passed", async () => {
    const site = await shopSite();
    const first = order(site);
    await insertOrder(db, first);
    expect((await insertOrder(db, order(site, { cartId: first.cartId }))).outcome).toBe("pending");
    expect((await insertOrder(db, order(site, { cartId: first.cartId, cartHash: first.cartHash, now: NOON + ORDER_LIMITS.repeatWindowMs + 1 }))).outcome).toBe("pending");
  });
});

describe("insertOrder: refusals (nothing stored)", () => {
  it("refuses a site whose live version is not the priced one, or that is taken down: not_live", async () => {
    const site = await shopSite();
    expect(await insertOrder(db, order({ siteId: site.siteId, versionId: newId() }))).toEqual({ outcome: "not_live" });
    await tools.DB.prepare("UPDATE sites SET taken_down_at = 5 WHERE id = ?").bind(site.siteId).run();
    const input = order(site);
    expect(await insertOrder(db, input)).toEqual({ outcome: "not_live" });
    expect(await stored(input.orderId)).toBeNull();
  });

  it("refuses while staff paused the site's orders, or all orders: paused", async () => {
    const site = await shopSite();
    await tools.DB.prepare("UPDATE sites SET orders_paused_at = 5, orders_paused_by = 'admin:staff@example.com' WHERE id = ?").bind(site.siteId).run();
    expect(await insertOrder(db, order(site))).toEqual({ outcome: "paused" });
    const other = await shopSite();
    await tools.DB.prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('orders_paused', '1', 1, 'admin:staff@example.com')").run();
    try {
      expect(await insertOrder(db, order(other))).toEqual({ outcome: "paused" });
    } finally {
      await tools.DB.prepare("DELETE FROM settings WHERE key = 'orders_paused'").run();
    }
    expect((await insertOrder(db, order(other))).outcome).toBe("pending");
  });

  it("refuses a site with no confirmed client order address: no_address (nobody would receive the order)", async () => {
    const site = await shopSite({ confirmed: false });
    expect(await insertOrder(db, order(site))).toEqual({ outcome: "no_address" });
    await tools.DB.prepare("UPDATE sites SET order_email = 'client@example.com' WHERE id = ?").bind(site.siteId).run();
    expect(await insertOrder(db, order(site))).toEqual({ outcome: "no_address" });
  });
});

describe("insertOrder: daily caps (UTC day)", () => {
  it(`allows ${ORDER_LIMITS.perNetworkPerSitePerDay} orders a day from one network on one site, then network_daily_limit; another network or the next day is fine`, async () => {
    const site = await shopSite();
    const net = newId();
    await fill(site.siteId, ORDER_LIMITS.perNetworkPerSitePerDay - 1, { netHash: net });
    expect(isStored(await insertOrder(db, order(site, { netHash: net })))).toBe(true);
    expect(await insertOrder(db, order(site, { netHash: net }))).toEqual({ outcome: "network_daily_limit" });
    expect(isStored(await insertOrder(db, order(site)))).toBe(true);
    expect(isStored(await insertOrder(db, order(site, { netHash: net, now: NOON + DAY_MS })))).toBe(true);
  });

  it("counts a network per site: the same network still orders on another site", async () => {
    const one = await shopSite();
    const two = await shopSite();
    const net = newId();
    await fill(one.siteId, ORDER_LIMITS.perNetworkPerSitePerDay, { netHash: net });
    expect(await insertOrder(db, order(one, { netHash: net }))).toEqual({ outcome: "network_daily_limit" });
    expect((await insertOrder(db, order(two, { netHash: net }))).outcome).toBe("pending");
  });

  it(`allows ${ORDER_LIMITS.perSitePerDay} orders a day per site (spam included), then site_daily_cap; yesterday's do not count`, async () => {
    const site = await shopSite();
    await fill(site.siteId, 3, { createdAt: NOON - DAY_MS });
    await fill(site.siteId, ORDER_LIMITS.perSitePerDay - 1, {});
    await fill(site.siteId, 1, { spam: 1, status: "skipped" });
    expect(await insertOrder(db, order(site))).toEqual({ outcome: "site_daily_cap" });
  });

  it("keeps the network cap exact when orders race: of 10 posted at once from one fresh network, exactly the cap is stored", async () => {
    const site = await shopSite();
    const net = newId();
    const results = await Promise.all(Array.from({ length: 10 }, () => insertOrder(db, order(site, { netHash: net }))));
    expect(results.filter((r) => r.outcome === "pending")).toHaveLength(ORDER_LIMITS.perNetworkPerSitePerDay);
    expect(results.filter((r) => r.outcome === "network_daily_limit")).toHaveLength(10 - ORDER_LIMITS.perNetworkPerSitePerDay);
    const numbers = results.flatMap((r) => ("number" in r ? [r.number] : [])).sort();
    expect(numbers).toEqual([1001, 1002, 1003, 1004, 1005]);
  });
});

describe("insertOrder: the order-email budgets", () => {
  it(`gives a site at most ${ORDER_LIMITS.emailsPerSitePerDay} emailed orders a day; past that it is stored as failed / daily_cap`, async () => {
    const site = await shopSite();
    await fill(site.siteId, ORDER_LIMITS.emailsPerSitePerDay, { status: "sent" });
    const input = order(site);
    expect(await insertOrder(db, input)).toEqual({ outcome: "failed", orderId: input.orderId, number: ORDER_LIMITS.emailsPerSitePerDay + 1001 });
    expect(await stored(input.orderId)).toMatchObject({ email_status: "failed", email_error: "daily_cap" });
  });

  it("does not count spam, held, capped or yesterday's orders toward a site's slice", async () => {
    const site = await shopSite();
    await fill(site.siteId, 4, { spam: 1, status: "skipped" });
    await fill(site.siteId, 4, { status: "held" });
    await fill(site.siteId, 4, { status: "failed", error: "daily_cap" });
    await fill(site.siteId, 4, { createdAt: NOON - DAY_MS });
    await fill(site.siteId, ORDER_LIMITS.emailsPerSitePerDay - 1, { status: "pending" });
    expect((await insertOrder(db, order(site))).outcome).toBe("pending");
  });

  it("stops order emails for all sites once the day's global budget is used; the order is still stored", async () => {
    // Its own day, so the other tests' orders do not count: the budget is global.
    const day = NOON + 30 * DAY_MS;
    const sites = await Promise.all(Array.from({ length: Math.ceil(EMAILS_PER_DAY / ORDER_LIMITS.emailsPerSitePerDay) }, () => shopSite()));
    for (const s of sites) await fill(s.siteId, ORDER_LIMITS.emailsPerSitePerDay, { createdAt: day, status: "sent" });
    const fresh = await shopSite();
    const input = order(fresh, { now: day, emailsPerDay: EMAILS_PER_DAY });
    expect(await insertOrder(db, input)).toEqual({ outcome: "failed", orderId: input.orderId, number: 1001 });
  });
});
