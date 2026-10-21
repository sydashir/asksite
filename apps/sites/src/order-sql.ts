import { ORDER_LIMITS, utcDayStart } from "@asksite/core";
import type { PricedLine } from "./pricing.ts";

// Storing an order (pages lane proposal 1.6 step 9). ONE statement stores it only while every rule allows it, so each
// rule stays exact when buyers post at the same time: D1 "processes queries one at a time" and a batch is one
// transaction (web-research.md §7). The same statement numbers the order and decides its email. Production SQL has no
// RETURNING (A10), so a read-back in the same batch says what happened.

export type Fulfilment = "pickup" | "delivery" | "shipping";

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
}

export interface Buyer {
  name: string;
  phone: string | null;
  email: string;
  fulfilment: Fulfilment;
  address: Address | null;
  note: string | null;
}

export interface NewOrder {
  orderId: string;
  siteId: string;
  /** The live version whose catalog priced the order: the site must still be live on exactly this version. */
  versionId: string;
  now: number;
  buyer: Buyer;
  items: readonly PricedLine[];
  subtotalCents: number;
  cartId: string;
  cartHash: string;
  spam: boolean;
  /** The visitor's /64 (ipRateKey), hashed. */
  ipHash: string;
  /** The visitor's /48 (ipDailyKey), hashed: the daily per-network cap's key. */
  netHash: string;
  /** ORDER_EMAILS_PER_DAY: order emails tried a UTC day across all sites. */
  emailsPerDay: number;
}

export type Stored = "pending" | "failed" | "skipped";
export type Refused = "not_live" | "paused" | "no_address" | "network_daily_limit" | "site_daily_cap";

export type InsertOrderResult =
  | { outcome: Stored | "duplicate"; orderId: string; number: number }
  | { outcome: Refused };

// The order-email count copies orders_emailed's WHERE exactly (0012_orders.sql), so SQLite can use that partial index.
const TRIED = "spam = 0 AND email_status IN ('pending', 'sent', 'failed') AND email_error IS NOT 'daily_cap'";

export const ORDER_INSERT_SQL = `
INSERT INTO orders (id, site_id, number, version_id, created_at, name, phone, email, fulfilment, address_json, note, items_json,
                    subtotal_cents, cart_id, cart_hash, spam, email_status, email_error, ip_hash, net_hash)
SELECT ?1, ?2, (SELECT COALESCE(MAX(number), 1000) + 1 FROM orders WHERE site_id = ?2), ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
       ?12, ?13, ?14, ?15,
       CASE WHEN ?15 = 1 THEN 'skipped' WHEN tried.n < ?18 AND tried.site_n < ?19 THEN 'pending' ELSE 'failed' END,
       CASE WHEN ?15 = 0 AND (tried.n >= ?18 OR tried.site_n >= ?19) THEN 'daily_cap' END,
       ?16, ?17
FROM (SELECT CASE WHEN ?15 = 1 THEN 0 ELSE (SELECT COUNT(*) FROM orders WHERE created_at >= ?20 AND ${TRIED}) END AS n,
             CASE WHEN ?15 = 1 THEN 0 ELSE (SELECT COUNT(*) FROM orders WHERE site_id = ?2 AND created_at >= ?20 AND ${TRIED}) END AS site_n
      WHERE EXISTS (SELECT 1 FROM sites WHERE id = ?2 AND live_version_id = ?3 AND taken_down_at IS NULL
                      AND orders_paused_at IS NULL AND order_email_confirmed_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'orders_paused' AND value = '1')
        AND NOT EXISTS (SELECT 1 FROM orders WHERE site_id = ?2 AND cart_id = ?13 AND cart_hash = ?14 AND created_at >= ?21)
        AND (SELECT COUNT(*) FROM orders WHERE net_hash = ?17 AND site_id = ?2 AND created_at >= ?20) < ?22
        AND (SELECT COUNT(*) FROM orders WHERE site_id = ?2 AND created_at >= ?20) < ?23) AS tried`;

const READ_BACK = `
SELECT (SELECT email_status FROM orders WHERE id = ?1) AS stored_status,
       (SELECT number FROM orders WHERE id = ?1) AS stored_number,
       repeat.id AS repeat_id, repeat.number AS repeat_number,
       EXISTS (SELECT 1 FROM sites WHERE id = ?2 AND live_version_id = ?3 AND taken_down_at IS NULL) AS live,
       (EXISTS (SELECT 1 FROM sites WHERE id = ?2 AND orders_paused_at IS NOT NULL)
         OR EXISTS (SELECT 1 FROM settings WHERE key = 'orders_paused' AND value = '1')) AS paused,
       EXISTS (SELECT 1 FROM sites WHERE id = ?2 AND order_email_confirmed_at IS NOT NULL) AS confirmed,
       (SELECT COUNT(*) FROM orders WHERE net_hash = ?6 AND site_id = ?2 AND created_at >= ?7) AS network_n
FROM (SELECT 1) LEFT JOIN (SELECT id, number FROM orders WHERE site_id = ?2 AND cart_id = ?4 AND cart_hash = ?5 AND created_at >= ?8 AND id <> ?1
                           ORDER BY created_at, number LIMIT 1) AS repeat`;

interface ReadBack {
  stored_status: string | null;
  stored_number: number | null;
  repeat_id: string | null;
  repeat_number: number | null;
  live: number;
  paused: number;
  confirmed: number;
  network_n: number;
}

/**
 * Stores the order unless: the site is not live on `versionId` or is taken down (not_live); staff paused the site's or
 * all orders (paused); the site has no confirmed client order address, so nobody would receive it (no_address); the
 * same cart with the same contents was ordered within ORDER_LIMITS.repeatWindowMs (duplicate, with that order's id and
 * number: a second tap lands on the first order); the network or the site has used its orders for the UTC day.
 * A stored order is numbered on from the site's last (1001 first), and its email is decided in the same statement:
 * spam is 'skipped'; otherwise 'pending' while today's tried order emails are under `emailsPerDay` across all sites and
 * under ORDER_LIMITS.emailsPerSitePerDay on this site, else 'failed' with email_error 'daily_cap'.
 */
export async function insertOrder(db: D1Database, input: NewOrder): Promise<InsertOrderResult> {
  const { orderId, siteId, versionId, now, buyer } = input;
  const dayStart = utcDayStart(now);
  const repeatSince = now - ORDER_LIMITS.repeatWindowMs;
  const [, readBack] = await db.batch<ReadBack>([
    db.prepare(ORDER_INSERT_SQL).bind(
      orderId, siteId, versionId, now, buyer.name, buyer.phone, buyer.email, buyer.fulfilment,
      buyer.address === null ? null : JSON.stringify(buyer.address), buyer.note, JSON.stringify(input.items),
      input.subtotalCents, input.cartId, input.cartHash, input.spam ? 1 : 0, input.ipHash, input.netHash,
      input.emailsPerDay, ORDER_LIMITS.emailsPerSitePerDay, dayStart, repeatSince,
      ORDER_LIMITS.perNetworkPerSitePerDay, ORDER_LIMITS.perSitePerDay,
    ),
    db.prepare(READ_BACK).bind(orderId, siteId, versionId, input.cartId, input.cartHash, input.netHash, dayStart, repeatSince),
  ]);
  const row = readBack?.results[0];
  if (row === undefined) throw new Error("insertOrder: the read-back SELECT returned no row");
  if (row.stored_status !== null && row.stored_number !== null) return { outcome: row.stored_status as Stored, orderId, number: row.stored_number };
  if (row.repeat_id !== null && row.repeat_number !== null) return { outcome: "duplicate", orderId: row.repeat_id, number: row.repeat_number };
  if (row.live !== 1) return { outcome: "not_live" };
  if (row.paused === 1) return { outcome: "paused" };
  if (row.confirmed !== 1) return { outcome: "no_address" };
  if (row.network_n >= ORDER_LIMITS.perNetworkPerSitePerDay) return { outcome: "network_daily_limit" };
  return { outcome: "site_daily_cap" };
}
