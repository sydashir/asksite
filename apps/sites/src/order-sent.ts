import { hashIp, ipRateKey, isId, livePointerKey } from "@asksite/core";
import { businessOf } from "./business.ts";
import { readCookie } from "./cart.ts";
import type { Env } from "./env.ts";
import { deriveOrderCookieKey, orderCookieName, verifyOrderCookie } from "./order-cookie.ts";
import type { FixedPage } from "./order.ts";
import type { PricedLine } from "./pricing.ts";
import type { Fulfilment, SentLineInput, SentSlotInput } from "./shop-markup-types.ts";

// GET /_o/<siteId>/sent/<orderId> (pages lane proposal 1.6 step 10; review I4). The order's number, lines, subtotal and
// fulfilment go only to the browser holding the signed order cookie for exactly this site and order, checked BEFORE any D1
// read; everyone else gets the generic "Order received" naming the business (from the LIVE pointer, no D1). SHOP_GET_RL
// bounds even a valid cookie's reads. Never the buyer's name, email, phone or address.

export type SentOutcome = { kind: "fixed"; page: FixedPage; code: string } | { kind: "sent"; slot: SentSlotInput; code?: string };

interface StoredOrder {
  number: number;
  items_json: string;
  subtotal_cents: number;
  fulfilment: Fulfilment;
}

const toSentLine = (l: PricedLine): SentLineInput => ({ name: l.name, ...(l.variantLabel === null ? {} : { variantLabel: l.variantLabel }), qty: l.qty, lineCents: l.lineCents });

export async function handleSent(request: Request, env: Env, input: { slug: string; siteId: string; orderId: string; now: number }): Promise<SentOutcome> {
  const { slug, siteId, orderId, now } = input;
  if (!isId(siteId) || !isId(orderId)) return { kind: "fixed", page: "not_found", code: "bad_id" };
  const meta = (await env.LIVE.head(livePointerKey(slug)))?.customMetadata;
  if (meta?.["siteId"] !== siteId) return { kind: "fixed", page: "not_found", code: "no_pointer" };
  const generic: SentOutcome = { kind: "sent", slot: { businessName: businessOf(meta).name ?? "" } };

  const secret = env.IP_HASH_KEY ?? "";
  const key = await deriveOrderCookieKey(secret);
  const cookie = readCookie(request.headers.get("cookie"), orderCookieName(env.ROOT_DOMAIN));
  if (!(await verifyOrderCookie(key, cookie, { siteId, orderId, now }))) return generic;

  const ipHash = await hashIp(secret, ipRateKey(request.headers.get("cf-connecting-ip") ?? "unknown"));
  const { success } = await env.SHOP_GET_RL.limit({ key: ipHash });
  if (!success) return { ...generic, code: "rate_limited" };

  const order = await env.DB.prepare("SELECT number, items_json, subtotal_cents, fulfilment FROM orders WHERE id = ? AND site_id = ?").bind(orderId, siteId).first<StoredOrder>();
  if (order === null) return generic;
  const lines = (JSON.parse(order.items_json) as PricedLine[]).map(toSentLine);
  return { kind: "sent", slot: { ...generic.slot, order: { number: order.number, lines, subtotalCents: order.subtotal_cents, fulfilment: order.fulfilment } } };
}
