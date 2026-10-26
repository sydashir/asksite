import { hashIp, ipDailyKey, ipRateKey, isId, livePointerKey, newId, ORDER_LIMITS } from "@asksite/core";
import { businessOf } from "./business.ts";
import { cartCookieName, clearCartCookie, parseCart, readCookie, setCartCookie } from "./cart.ts";
import { orderEmailsPerDay } from "./config.ts";
import type { Env } from "./env.ts";
import { readLimited } from "./form.ts";
import { hasTooManyLinks } from "./lead.ts";
import { readOrderForm } from "./order-form.ts";
import { deriveOrderCookieKey, ORDER_COOKIE_TTL_MS, setOrderCookie, signOrderCookie } from "./order-cookie.ts";
import { insertOrder } from "./order-sql.ts";
import { isSameOriginPost } from "./origin.ts";
import { cartQuote, priceCart, type PricedLine, type PricingCatalog } from "./pricing.ts";
import type { CartLineInput, CartSlotInput, Fulfilment, RefusalReason } from "./shop-markup-types.ts";

// POST /_o/<siteId> on a site host (pages lane proposal 1.6). handleOrder decides and returns WHAT to answer as data;
// the router writes the page with Plan 3's cart-markup inside the version's shop shell. The order of checks: cheap and
// header-only first (id, same origin, content type, size), then the secret and the burst brake, then the honeypot, then
// R2 (pointer, catalog), and D1 last, once (insertOrder). Nothing here writes a buyer's value to the log: outcomes carry
// codes only.

/**
 * The version's catalog as the shop contract (§3) defines it: resolved values only. A local mirror of site-schema's
 * Catalog until lane A's contract commit merges.
 */
export type ShopCatalog = PricingCatalog & {
  readonly v: 1;
  readonly currency: "USD";
  readonly checkout: "request" | "card";
  readonly fulfilment: readonly Fulfilment[];
  readonly orderNote?: string;
};

export interface OrderDeps {
  /** The catalog of the live version `versionId`, or null when that version has none (no shop). */
  loadCatalog(versionId: string): Promise<ShopCatalog | null>;
}

/** The business the refusal pages name: from the LIVE pointer, as the form's pages (business.ts). */
export interface ShopBusiness {
  name: string;
  /** E.164, as the pointer stores it. */
  phone?: string;
}

export type FixedPage = "not_found" | "forbidden" | "unsupported_media_type" | "too_large" | "unavailable";

export type OrderOutcome =
  | { kind: "fixed"; page: FixedPage; code: string }
  | { kind: "honeypot"; code: "honeypot" }
  | { kind: "cart_empty"; setCart?: string; code: "cart_empty" }
  | { kind: "refusal"; status: 403 | 422 | 429; reason: RefusalReason; business: ShopBusiness; code: string }
  | { kind: "form"; status: 409 | 422; slot: CartSlotInput; setCart?: string; code: string }
  | { kind: "placed"; orderId: string; number: number; location: string; setCookies: string[]; emailPending: boolean; code?: string };

/** 16 KiB: the order form at every field's maxlength stays far below it. */
const ORDER_MAX_BODY_BYTES = 16 * 1024;

const fixed = (page: FixedPage, code: string): OrderOutcome => ({ kind: "fixed", page, code });

/** A priced line as cart-markup takes it: optional fields left out rather than null. */
export const toLineInput = (l: PricedLine): CartLineInput => ({
  productId: l.productId,
  ...(l.variantId === null ? {} : { variantId: l.variantId }),
  slug: l.slug,
  name: l.name,
  ...(l.variantLabel === null ? {} : { variantLabel: l.variantLabel }),
  unitCents: l.unitCents,
  ...(l.compareAtCents === null ? {} : { compareAtCents: l.compareAtCents }),
  qty: l.qty,
  maxQty: l.maxQty,
  lineCents: l.lineCents,
});

export async function handleOrder(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  input: { slug: string; siteId: string; now: number },
  deps: OrderDeps,
): Promise<OrderOutcome> {
  void ctx; // the order email is sent by the router (it owns waitUntil), from the outcome
  const { slug, siteId, now } = input;
  const root = env.ROOT_DOMAIN;
  if (!isId(siteId)) return fixed("not_found", "bad_site_id");
  // Before reading anything: a post from another page (another tenant shares the registrable domain) is refused (origin.ts).
  if (!isSameOriginPost(request)) return fixed("forbidden", "cross_site");
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return fixed("unsupported_media_type", "unsupported_media_type");
  const body = await readLimited(request, ORDER_MAX_BODY_BYTES);
  if (body === null) return fixed("too_large", "payload_too_large");

  const secret = env.IP_HASH_KEY ?? "";
  if (secret === "") return fixed("unavailable", "misconfigured");
  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  const ipHash = await hashIp(secret, ipRateKey(address));
  const netHash = await hashIp(secret, ipDailyKey(address));

  const pointerBusiness = async (): Promise<ShopBusiness> => {
    try {
      const meta = (await env.LIVE.head(livePointerKey(slug)))?.customMetadata;
      const business = meta?.["siteId"] === siteId ? businessOf(meta) : { name: null, phone: null };
      return { name: business.name ?? "", ...(business.phone === null ? {} : { phone: business.phone.tel }) };
    } catch {
      return { name: "" };
    }
  };

  // The burst brake (approximate, per location): the exact limits are insertOrder's D1 counts.
  const { success } = await env.ORDER_RL.limit({ key: `${siteId}:${ipHash}` });
  if (!success) return { kind: "refusal", status: 429, reason: "rate_limited", business: await pointerBusiness(), code: "rate_limited" };

  const fields = new URLSearchParams(body);
  if ((fields.get("website") ?? "") !== "") return { kind: "honeypot", code: "honeypot" };

  // R2: the pointer names the live version (a site with none never reaches D1, Decision 24), then its catalog.
  const pointer = await env.LIVE.head(livePointerKey(slug));
  const meta = pointer?.customMetadata;
  if (pointer === null || meta?.["siteId"] !== siteId) return fixed("not_found", "no_pointer");
  const versionId = meta["versionId"] ?? "";
  if (!isId(versionId)) return fixed("unavailable", "bad_pointer");
  const known = businessOf(meta);
  const business: ShopBusiness = { name: known.name ?? "", ...(known.phone === null ? {} : { phone: known.phone.tel }) };
  const catalog = await deps.loadCatalog(versionId);
  if (catalog === null) return fixed("not_found", "no_shop");

  // The cart, priced from this version's catalog alone; then what the buyer saw (the quote) must still hold.
  const cart = parseCart(readCookie(request.headers.get("cookie"), cartCookieName(root)), siteId);
  if (cart === null || cart.lines.length === 0) return { kind: "cart_empty", code: "cart_empty" };
  const priced = priceCart(catalog, cart);
  if (priced.lines.length === 0) return { kind: "cart_empty", setCart: setCartCookie(root, priced.cart), code: "cart_empty" };
  const quote = await cartQuote(versionId, priced.lines);
  const form = readOrderForm(fields, catalog.fulfilment);
  const slot: CartSlotInput = {
    siteId,
    lines: priced.lines.map(toLineInput),
    subtotalCents: priced.subtotalCents,
    fulfilment: catalog.fulfilment,
    ...(catalog.orderNote === undefined ? {} : { orderNote: catalog.orderNote }),
    quote,
    refill: form.refill,
  };
  if (priced.changed) {
    const dropped = priced.lines.length < cart.lines.length;
    return { kind: "form", status: 409, slot: { ...slot, notices: [dropped ? "items_removed" : "prices_changed"] }, setCart: setCartCookie(root, priced.cart), code: "cart_changed" };
  }
  if ((fields.get("quote") ?? "") !== quote) return { kind: "form", status: 409, slot: { ...slot, notices: ["prices_changed"] }, code: "prices_changed" };
  if (!form.ok) return { kind: "form", status: 422, slot: { ...slot, errors: form.errors }, code: "validation_failed" };
  if (priced.subtotalCents > ORDER_LIMITS.maxOrderCents) return { kind: "refusal", status: 422, reason: "order_too_large", business, code: "order_too_large" };

  // D1, once: every rule in one statement (order-sql.ts).
  const stored = await insertOrder(env.DB, {
    orderId: newId(), siteId, versionId, now, buyer: form.buyer, items: priced.lines, subtotalCents: priced.subtotalCents,
    cartId: cart.cartId, cartHash: quote, spam: hasTooManyLinks(form.buyer.note), ipHash, netHash,
    emailsPerDay: orderEmailsPerDay(env.ORDER_EMAILS_PER_DAY),
  });
  switch (stored.outcome) {
    case "not_live":
      return fixed("not_found", "not_live");
    case "paused":
      return { kind: "refusal", status: 403, reason: "orders_paused", business, code: "orders_paused" };
    case "no_address":
      return { kind: "refusal", status: 403, reason: "not_available", business, code: "no_address" };
    case "network_daily_limit":
    case "site_daily_cap":
      return { kind: "refusal", status: 429, reason: "daily_cap", business, code: stored.outcome };
    default: {
      const key = await deriveOrderCookieKey(secret);
      const setCookies = [clearCartCookie(root)];
      if (key !== null) setCookies.unshift(setOrderCookie(root, await signOrderCookie(key, { siteId, orderId: stored.orderId, expiresAt: now + ORDER_COOKIE_TTL_MS })));
      return {
        kind: "placed",
        orderId: stored.orderId,
        number: stored.number,
        location: `/_o/${siteId}/sent/${stored.orderId}`,
        setCookies,
        emailPending: stored.outcome === "pending",
        ...(stored.outcome === "pending" ? {} : { code: stored.outcome === "failed" ? "order_email_cap_reached" : stored.outcome }),
      };
    }
  }
}
