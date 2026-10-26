import { ApiError } from "@asksite/app-common";
import { isId, utcDayStart, type OrderDetail, type OrderItemView, type OrderListItem, type SiteShopStatus } from "@asksite/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AdminEnv } from "../types.ts";

// The staff orders API (pages lane proposal 1.8, 1.9). Staff list every site's orders, open one, cancel it or mark it as
// spam, and pause one site's orders or all of them. Each change is conditional on the state staff saw (409 otherwise)
// and audited in the same batch, written only when the change was (changes() = 1). Orders are placed by the sites Worker
// (apps/sites/src/order.ts); the global pause is the setting it reads (orders_paused = '1').

const ListQuery = z.strictObject({
  siteId: z.string().refine(isId).optional(),
  spam: z.enum(["0", "1"]).default("0"),
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

interface OrderRow {
  id: string;
  site_id: string;
  slug: string | null;
  number: number;
  created_at: number;
  name: string;
  subtotal_cents: number;
  status: OrderListItem["status"];
  spam: number;
  email_status: OrderListItem["emailStatus"];
  email_error: string | null;
}

interface OrderDetailRow extends OrderRow {
  email: string;
  phone: string | null;
  fulfilment: OrderDetail["fulfilment"];
  address_json: string | null;
  note: string | null;
  items_json: string;
  status_at: number | null;
  status_by: string | null;
}

const LIST_COLUMNS = "o.id, o.site_id, s.slug, o.number, o.created_at, o.name, o.subtotal_cents, o.status, o.spam, o.email_status, o.email_error";

const toListItem = (r: OrderRow): OrderListItem => ({
  id: r.id, siteId: r.site_id, slug: r.slug, number: r.number, createdAt: r.created_at, name: r.name, subtotalCents: r.subtotal_cents,
  status: r.status, spam: r.spam === 1, emailStatus: r.email_status, emailError: r.email_error,
});

/** An audit row written in the same batch as the change before it, only when that change happened (SQLite changes()). */
const auditIfChanged = (db: D1Database, entry: { at: number; actor: string; action: string; siteId: string | null; detail: Record<string, unknown> }) =>
  db.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?, ?, ?, ?, ? WHERE changes() = 1")
    .bind(entry.at, entry.actor, entry.action, entry.siteId, JSON.stringify(entry.detail));

export function orderRoutes(): Hono<AdminEnv> {
  const orders = new Hono<AdminEnv>();

  orders.get("/orders", async (c) => {
    const query = ListQuery.safeParse(c.req.query());
    if (!query.success) throw new ApiError("bad_request", "Invalid orders request");
    const { siteId, spam, before, limit } = query.data;
    const where = ["o.spam = ?", "o.created_at < ?", ...(siteId === undefined ? [] : ["o.site_id = ?"])].join(" AND ");
    const binds: unknown[] = [Number(spam), before ?? Number.MAX_SAFE_INTEGER, ...(siteId === undefined ? [] : [siteId])];
    const { results } = await c.env.DB.prepare(
      `SELECT ${LIST_COLUMNS} FROM orders o JOIN sites s ON s.id = o.site_id WHERE ${where} ORDER BY o.created_at DESC, o.id DESC LIMIT ?`,
    ).bind(...binds, limit + 1).all<OrderRow>();
    let page = results.slice(0, limit);
    let nextBefore: number | null = null;
    const edge = page.at(-1)?.created_at;
    // As the leads list (apps/app routes/leads.ts): `before` is exclusive, so a page never ends inside one millisecond.
    if (edge !== undefined && results.length > limit) {
      nextBefore = edge;
      if (results[limit]?.created_at === edge) {
        const tied = await c.env.DB.prepare(`SELECT ${LIST_COLUMNS} FROM orders o JOIN sites s ON s.id = o.site_id WHERE ${where.replace("o.created_at < ?", "o.created_at = ?")} ORDER BY o.id DESC`)
          .bind(Number(spam), edge, ...(siteId === undefined ? [] : [siteId])).all<OrderRow>();
        page = [...page.filter((o) => o.created_at !== edge), ...tied.results];
      }
    }
    return c.json({ orders: page.map(toListItem), nextBefore });
  });

  orders.get("/orders/:orderId", async (c) => {
    const orderId = c.req.param("orderId");
    if (!isId(orderId)) throw new ApiError("not_found", "No such order");
    const row = await c.env.DB.prepare(
      `SELECT ${LIST_COLUMNS}, o.email, o.phone, o.fulfilment, o.address_json, o.note, o.items_json, o.status_at, o.status_by
       FROM orders o JOIN sites s ON s.id = o.site_id WHERE o.id = ?`,
    ).bind(orderId).first<OrderDetailRow>();
    if (row === null) throw new ApiError("not_found", "No such order");
    const items = (JSON.parse(row.items_json) as Array<OrderItemView & Record<string, unknown>>).map(
      ({ name, variantLabel, unitCents, qty, lineCents }): OrderItemView => ({ name, variantLabel, unitCents, qty, lineCents }),
    );
    const detail: OrderDetail = {
      ...toListItem(row), email: row.email, phone: row.phone, fulfilment: row.fulfilment,
      address: row.address_json === null ? null : (JSON.parse(row.address_json) as OrderDetail["address"]), note: row.note, items,
      statusAt: row.status_at, statusBy: row.status_by,
    };
    return c.json(detail);
  });

  /** A conditional change of one order, audited with it; 404 when there is no such order, 409 when its state moved on. */
  async function changeOrder(c: { env: Env; get(key: "admin"): string }, orderId: string, change: { set: string; when: string; action: string }) {
    if (!isId(orderId)) throw new ApiError("not_found", "No such order");
    const db = c.env.DB;
    const now = Date.now();
    const actor = `admin:${c.get("admin")}`;
    const order = await db.prepare("SELECT site_id, number FROM orders WHERE id = ?").bind(orderId).first<{ site_id: string; number: number }>();
    if (order === null) throw new ApiError("not_found", "No such order");
    const [changed] = await db.batch([
      db.prepare(`UPDATE orders SET ${change.set} WHERE id = ? AND ${change.when}`).bind(now, actor, orderId),
      auditIfChanged(db, { at: now, actor, action: change.action, siteId: order.site_id, detail: { orderId, number: order.number } }),
    ]);
    if (changed?.meta.changes !== 1) throw new ApiError("conflict", "This order has changed. Reload it and try again.");
  }

  orders.post("/orders/:orderId/cancel", async (c) => {
    await changeOrder(c, c.req.param("orderId"), { set: "status = 'cancelled', status_at = ?, status_by = ?", when: "status = 'new'", action: "order.cancelled" });
    return c.json({ status: "cancelled" });
  });

  orders.post("/orders/:orderId/spam", async (c) => {
    await changeOrder(c, c.req.param("orderId"), { set: "spam = 1, status_at = ?, status_by = ?", when: "spam = 0", action: "order.marked_spam" });
    return c.json({ spam: true });
  });

  /** Staff's switch for all orders: the setting the sites Worker reads in the order's one statement. */
  async function setAllPaused(c: { env: Env; get(key: "admin"): string }, paused: boolean) {
    const db = c.env.DB;
    const now = Date.now();
    const actor = `admin:${c.get("admin")}`;
    await db.batch([
      db.prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('orders_paused', ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by")
        .bind(paused ? "1" : "0", now, actor),
      db.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (?, ?, ?, NULL, NULL)").bind(now, actor, paused ? "orders.paused_all" : "orders.resumed_all"),
    ]);
  }

  orders.post("/orders/pause-all", async (c) => {
    await setAllPaused(c, true);
    return c.json({ allOrdersPaused: true });
  });

  orders.post("/orders/resume-all", async (c) => {
    await setAllPaused(c, false);
    return c.json({ allOrdersPaused: false });
  });

  orders.get("/sites/:siteId/shop", async (c) => {
    const siteId = c.req.param("siteId");
    if (!isId(siteId)) throw new ApiError("not_found", "No such site");
    const row = await c.env.DB.prepare(
      `SELECT s.orders_paused_at, s.orders_paused_by, s.order_email, s.order_email_rev, s.order_email_confirmed_at, s.order_email_confirmed_by,
              (SELECT COUNT(*) FROM orders WHERE site_id = s.id) AS order_count,
              (SELECT COUNT(*) FROM orders WHERE site_id = s.id AND created_at >= ?) AS orders_today,
              EXISTS (SELECT 1 FROM settings WHERE key = 'orders_paused' AND value = '1') AS all_paused
       FROM sites s WHERE s.id = ?`,
    ).bind(utcDayStart(Date.now()), siteId).first<{
      orders_paused_at: number | null; orders_paused_by: string | null; order_email: string | null; order_email_rev: number;
      order_email_confirmed_at: number | null; order_email_confirmed_by: string | null; order_count: number; orders_today: number; all_paused: number;
    }>();
    if (row === null) throw new ApiError("not_found", "No such site");
    const status: SiteShopStatus = {
      ordersPausedAt: row.orders_paused_at, ordersPausedBy: row.orders_paused_by, allOrdersPaused: row.all_paused === 1,
      orderEmail: row.order_email, orderEmailRev: row.order_email_rev, orderEmailConfirmedAt: row.order_email_confirmed_at,
      orderEmailConfirmedBy: row.order_email_confirmed_by, orderCount: row.order_count, ordersToday: row.orders_today,
    };
    return c.json(status);
  });

  /** One site's orders pause: set only when open, cleared only when set (409 otherwise); audited with it. */
  async function setSitePaused(c: { env: Env; get(key: "admin"): string }, siteId: string, paused: boolean) {
    if (!isId(siteId)) throw new ApiError("not_found", "No such site");
    const db = c.env.DB;
    if ((await db.prepare("SELECT 1 AS found FROM sites WHERE id = ?").bind(siteId).first()) === null) throw new ApiError("not_found", "No such site");
    const now = Date.now();
    const actor = `admin:${c.get("admin")}`;
    const update = paused
      ? db.prepare("UPDATE sites SET orders_paused_at = ?, orders_paused_by = ? WHERE id = ? AND orders_paused_at IS NULL").bind(now, actor, siteId)
      : db.prepare("UPDATE sites SET orders_paused_at = NULL, orders_paused_by = NULL WHERE id = ? AND orders_paused_at IS NOT NULL").bind(siteId);
    const [changed] = await db.batch([update, auditIfChanged(db, { at: now, actor, action: paused ? "site.orders_paused" : "site.orders_resumed", siteId, detail: {} })]);
    if (changed?.meta.changes !== 1) throw new ApiError("conflict", paused ? "Orders are already paused." : "Orders are not paused.");
  }

  orders.post("/sites/:siteId/orders/pause", async (c) => {
    await setSitePaused(c, c.req.param("siteId"), true);
    return c.json({ ordersPaused: true });
  });

  orders.post("/sites/:siteId/orders/resume", async (c) => {
    await setSitePaused(c, c.req.param("siteId"), false);
    return c.json({ ordersPaused: false });
  });

  return orders;
}
