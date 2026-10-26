import { newId } from "@asksite/core";
import { describe, expect, it } from "vitest";
import { json, useAdminHarness } from "../support/harness.ts";

// The staff orders API (pages lane proposal 1.8, 1.9; strict tier: customer data). Staff (Access + the allowlist, as
// every admin route) list every site's orders, open one, cancel it or mark it as spam, and pause a site's orders or all
// orders. Every change is conditional on the state the staff member saw, and audited.

const h = useAdminHarness();

const LINES = [{ productId: newId(), variantId: null, slug: "mom-flipflop", name: "Mom Flipflop", variantLabel: null, unitCents: 5000, compareAtCents: null, qty: 2, maxQty: 10, lineCents: 10000 }];

async function seedOrder(siteId: string, over: { number?: number; createdAt?: number; spam?: 0 | 1; status?: string; name?: string } = {}): Promise<string> {
  const id = newId();
  const db = await h.db();
  await db
    .prepare(
      `INSERT INTO orders (id, site_id, number, version_id, created_at, name, phone, email, fulfilment, address_json, note, items_json, subtotal_cents, cart_id, cart_hash, status, spam, email_status, ip_hash, net_hash)
       VALUES (?, ?, ?, ?, ?, ?, '+15125550199', 'dana@example.com', 'delivery', '{"line1":"1 Main St","city":"Austin","state":"TX","zip":"78701"}', 'Gate 12', ?, 10000, ?, 'h', ?, ?, 'sent', 'i', 'n')`,
    )
    .bind(id, siteId, over.number ?? 1001, newId(), over.createdAt ?? Date.now(), over.name ?? "Dana Price", JSON.stringify(LINES), newId(), over.status ?? "new", over.spam ?? 0)
    .run();
  return id;
}

const audits = async (action: string) =>
  (await (await h.db()).prepare("SELECT actor, site_id, detail_json FROM audit_log WHERE action = ? ORDER BY id").bind(action).all<Record<string, unknown>>()).results;

describe("GET /api/admin/orders", () => {
  it("lists a site's orders newest first with what the list shows, spam hidden", async () => {
    const site = await h.pendingSite();
    const older = await seedOrder(site.siteId, { number: 1001, createdAt: 1_000 });
    const newer = await seedOrder(site.siteId, { number: 1002, createdAt: 2_000 });
    await seedOrder(site.siteId, { number: 1003, createdAt: 3_000, spam: 1 });
    const { orders, nextBefore } = await json<{ orders: Array<Record<string, unknown>>; nextBefore: number | null }>(await h.call("GET", `/api/admin/orders?siteId=${site.siteId}`));
    expect(orders.map((o) => o["id"])).toEqual([newer, older]);
    expect(orders[0]).toEqual({
      id: newer, siteId: site.siteId, slug: site.slug, number: 1002, createdAt: 2_000, name: "Dana Price", subtotalCents: 10000,
      status: "new", spam: false, emailStatus: "sent", emailError: null,
    });
    expect(nextBefore).toBeNull();
  });

  it("shows only spam with spam=1, and pages by createdAt", async () => {
    const site = await h.pendingSite();
    const spam = await seedOrder(site.siteId, { number: 1001, createdAt: 5_000, spam: 1 });
    expect((await json<{ orders: Array<{ id: string }> }>(await h.call("GET", `/api/admin/orders?siteId=${site.siteId}&spam=1`))).orders.map((o) => o.id)).toEqual([spam]);
    for (let i = 0; i < 3; i++) await seedOrder(site.siteId, { number: 1002 + i, createdAt: 10_000 + i });
    const first = await json<{ orders: Array<{ id: string; createdAt: number }>; nextBefore: number | null }>(await h.call("GET", `/api/admin/orders?siteId=${site.siteId}&limit=2`));
    expect(first.orders.map((o) => o.createdAt)).toEqual([10_002, 10_001]);
    expect(first.nextBefore).toBe(10_001);
    const second = await json<{ orders: Array<{ createdAt: number }> }>(await h.call("GET", `/api/admin/orders?siteId=${site.siteId}&limit=2&before=${first.nextBefore}`));
    expect(second.orders.map((o) => o.createdAt)).toEqual([10_000]);
  });

  it("refuses a bad query, and needs Access like every admin route", async () => {
    expect((await h.call("GET", "/api/admin/orders?siteId=nope")).status).toBe(400);
    expect((await h.call("GET", "/api/admin/orders?limit=500")).status).toBe(400);
    expect((await h.call("GET", "/api/admin/orders", { token: null })).status).toBe(403);
  });
});

describe("GET /api/admin/orders/:orderId", () => {
  it("opens one order with its buyer, address, note and lines", async () => {
    const site = await h.pendingSite();
    const id = await seedOrder(site.siteId);
    expect(await json(await h.call("GET", `/api/admin/orders/${id}`))).toMatchObject({
      id, siteId: site.siteId, slug: site.slug, number: 1001, name: "Dana Price", email: "dana@example.com", phone: "+15125550199",
      fulfilment: "delivery", address: { line1: "1 Main St", city: "Austin", state: "TX", zip: "78701" }, note: "Gate 12",
      items: [{ name: "Mom Flipflop", variantLabel: null, unitCents: 5000, qty: 2, lineCents: 10000 }], subtotalCents: 10000, status: "new", statusAt: null, statusBy: null,
    });
  });

  it("answers 404 for an unknown or malformed id", async () => {
    expect((await h.call("GET", `/api/admin/orders/${newId()}`)).status).toBe(404);
    expect((await h.call("GET", "/api/admin/orders/nope")).status).toBe(404);
  });
});

describe("cancel and mark as spam", () => {
  it("cancels a new order once, records who and when, and audits it", async () => {
    const site = await h.pendingSite();
    const id = await seedOrder(site.siteId);
    expect((await h.call("POST", `/api/admin/orders/${id}/cancel`)).status).toBe(200);
    expect(await json(await h.call("GET", `/api/admin/orders/${id}`))).toMatchObject({ status: "cancelled", statusBy: "admin:admin@example.com" });
    expect((await h.call("POST", `/api/admin/orders/${id}/cancel`)).status).toBe(409);
    expect((await audits("order.cancelled")).filter((a) => String(a["detail_json"]).includes(id))).toHaveLength(1);
  });

  it("marks an order as spam once (it leaves the list), and audits it", async () => {
    const site = await h.pendingSite();
    const id = await seedOrder(site.siteId);
    expect((await h.call("POST", `/api/admin/orders/${id}/spam`)).status).toBe(200);
    expect((await json<{ orders: unknown[] }>(await h.call("GET", `/api/admin/orders?siteId=${site.siteId}`))).orders).toEqual([]);
    expect((await h.call("POST", `/api/admin/orders/${id}/spam`)).status).toBe(409);
    expect((await audits("order.marked_spam")).filter((a) => String(a["detail_json"]).includes(id))).toHaveLength(1);
  });

  it("answers 404 for an unknown order, and refuses a post from another origin", async () => {
    expect((await h.call("POST", `/api/admin/orders/${newId()}/cancel`)).status).toBe(404);
    const site = await h.pendingSite();
    const id = await seedOrder(site.siteId);
    expect((await h.call("POST", `/api/admin/orders/${id}/cancel`, { origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("pausing orders", () => {
  it("pauses and resumes one site's orders (each once), shown in the site's shop status, audited", async () => {
    const site = await h.pendingSite();
    const status = async () => json<Record<string, unknown>>(await h.call("GET", `/api/admin/sites/${site.siteId}/shop`));
    expect(await status()).toMatchObject({ ordersPausedAt: null, orderEmail: null, orderEmailConfirmedAt: null, orderEmailRev: 0, orderCount: 0, ordersToday: 0, allOrdersPaused: false });
    expect((await h.call("POST", `/api/admin/sites/${site.siteId}/orders/pause`)).status).toBe(200);
    expect(await status()).toMatchObject({ ordersPausedAt: expect.any(Number), ordersPausedBy: "admin:admin@example.com" });
    expect((await h.call("POST", `/api/admin/sites/${site.siteId}/orders/pause`)).status).toBe(409);
    expect((await h.call("POST", `/api/admin/sites/${site.siteId}/orders/resume`)).status).toBe(200);
    expect(await status()).toMatchObject({ ordersPausedAt: null, ordersPausedBy: null });
    expect((await h.call("POST", `/api/admin/sites/${site.siteId}/orders/resume`)).status).toBe(409);
    expect((await audits("site.orders_paused")).filter((a) => a["site_id"] === site.siteId)).toHaveLength(1);
    expect((await audits("site.orders_resumed")).filter((a) => a["site_id"] === site.siteId)).toHaveLength(1);
  });

  it("pauses and resumes all orders with the setting the sites Worker reads (orders_paused = '1')", async () => {
    const site = await h.pendingSite();
    const setting = async () => (await (await h.db()).prepare("SELECT value FROM settings WHERE key = 'orders_paused'").first<{ value: string }>())?.value ?? null;
    expect((await h.call("POST", "/api/admin/orders/pause-all")).status).toBe(200);
    expect(await setting()).toBe("1");
    expect(await json(await h.call("GET", `/api/admin/sites/${site.siteId}/shop`))).toMatchObject({ allOrdersPaused: true });
    expect((await h.call("POST", "/api/admin/orders/resume-all")).status).toBe(200);
    expect(await setting()).toBe("0");
    expect((await audits("orders.paused_all")).length).toBeGreaterThan(0);
    expect((await audits("orders.resumed_all")).length).toBeGreaterThan(0);
  });

  it("counts a site's orders: all, and today's (UTC)", async () => {
    const site = await h.pendingSite();
    await seedOrder(site.siteId, { number: 1001, createdAt: 1_000 });
    await seedOrder(site.siteId, { number: 1002 });
    expect(await json(await h.call("GET", `/api/admin/sites/${site.siteId}/shop`))).toMatchObject({ orderCount: 2, ordersToday: 1 });
  });

  it("answers 404 for an unknown site", async () => {
    expect((await h.call("GET", `/api/admin/sites/${newId()}/shop`)).status).toBe(404);
    expect((await h.call("POST", `/api/admin/sites/${newId()}/orders/pause`)).status).toBe(404);
  });
});
