import { isId, type OrderDetail, type OrderEmailStatus, type OrderFulfilment, type OrderListItem, type OrderStatus, type SiteShopStatus } from "@asksite/core";

// The staff orders screens' words and small rules (admin-orders-plan.md), kept out of the components so they are tested on
// their own. Every amount comes from the order the server stored; nothing here adds up money.

/** US English on screen ("Canceled"); the API's stored value stays "cancelled". */
export const STATUS_WORD: Record<OrderStatus, string> = { new: "New", cancelled: "Canceled" };

export const FULFILMENT_WORD: Record<OrderFulfilment, string> = { pickup: "Pickup", delivery: "Local delivery", shipping: "Shipping" };

/** What happened to the order email for the client. Codes the server may add later show as they are, so nothing is hidden. */
export function emailLine(status: OrderEmailStatus, error: string | null): string {
  switch (status) {
    case "sent":
      return "Emailed to the client";
    case "pending":
      return "Email not sent yet";
    case "skipped":
      return "Not emailed";
    case "held":
      return "Waiting for card payment";
    case "failed":
      if (error === null) return "Email failed";
      return error === "daily_cap" ? "Email failed: daily email limit reached" : `Email failed (code: ${error})`;
  }
}

/** Who changed the order: the server stores "admin:<email>"; anything else is shown as it is. */
export const staffName = (statusBy: string): string => (statusBy.startsWith("admin:") ? statusBy.slice("admin:".length) : statusBy);

/**
 * The line under a changed order. The API keeps one statusAt/statusBy for both changes, so when an order is both cancelled and
 * spam the line can name only the last change.
 */
export function statusChangeText(order: Pick<OrderDetail, "status" | "spam" | "statusAt" | "statusBy">, time: (ms: number) => string): string | null {
  if (order.statusAt === null || order.statusBy === null) return null;
  const by = `${staffName(order.statusBy)} on ${time(order.statusAt)}`;
  if (order.status === "cancelled" && order.spam) return `Last changed by ${by}.`;
  if (order.status === "cancelled") return `Canceled by ${by}.`;
  if (order.spam) return `Marked as spam by ${by}.`;
  return null;
}

/**
 * A mailto link for the buyer with the order number in the subject. Null when the buyer's text could add its own parts to the
 * link (a "?", "&", "#", "%" or a space): the address is then shown as text only.
 */
export function buyerMailto(order: Pick<OrderDetail, "number" | "email">): string | null {
  if (/[?&#%\s]/.test(order.email)) return null;
  return `mailto:${order.email}?subject=${encodeURIComponent(`Your order #${order.number}`)}`;
}

/** The address as lines: "1 Main St", "Apt 4", "Austin, TX 78701". */
export function addressLines(address: NonNullable<OrderDetail["address"]>): string[] {
  return [address.line1, ...(address.line2 === undefined || address.line2 === "" ? [] : [address.line2]), `${address.city}, ${address.state} ${address.zip}`];
}

export interface OrdersFilters {
  siteId: string | null;
  spam: boolean;
}

/** The filters in the page address (/orders?site=<id>&spam=1). Anything else is ignored (the site id by the API's own rule), so a bad link shows all orders. */
export function readOrdersFilters(search: string): OrdersFilters {
  const params = new URLSearchParams(search);
  const site = params.get("site");
  return { siteId: site !== null && isId(site) ? site : null, spam: params.get("spam") === "1" };
}

/** The page address for some filters. */
export function ordersPath(filters: OrdersFilters): string {
  const params = new URLSearchParams();
  if (filters.siteId !== null) params.set("site", filters.siteId);
  if (filters.spam) params.set("spam", "1");
  const query = params.toString();
  return query === "" ? "/orders" : `/orders?${query}`;
}

/** The API request for one page of orders. */
export function ordersRequest(filters: OrdersFilters, before: number | null, limit = 50): string {
  const params = new URLSearchParams({ spam: filters.spam ? "1" : "0", limit: String(limit) });
  if (filters.siteId !== null) params.set("siteId", filters.siteId);
  if (before !== null) params.set("before", String(before));
  return `/api/admin/orders?${params.toString()}`;
}

export function emptyOrdersText(filters: OrdersFilters): string {
  if (filters.spam) return "Nothing is marked as spam.";
  return filters.siteId === null ? "No orders yet. When a buyer orders from a shop, it shows up here." : "No orders for this site yet.";
}

/** A list row's one-line summary for screen readers and the visible meta line. */
export const orderSiteLabel = (order: Pick<OrderListItem, "slug">): string => order.slug ?? "(no web address)";

/**
 * Why a shop cannot take orders right now, or null when it can. The checks are the sites Worker's own insert guard
 * (apps/sites/src/order-sql.ts): the site is live and not taken down, its orders are not paused, orders are not paused on every
 * shop, and its order address is confirmed. `live` comes from the site row (null when the row is not known): an unknown state
 * is never reported as able to take orders.
 */
export function orderBlocker(status: SiteShopStatus, live: boolean | null): string | null {
  if (live === false) return "the site is not live";
  if (status.ordersPausedAt !== null) return "orders are paused for this site";
  if (status.allOrdersPaused) return "orders are paused on every shop";
  if (status.orderEmailConfirmedAt === null) return status.orderEmail === null ? "it has no order address yet" : "its order address is not confirmed yet";
  if (live === null) return "the site's state could not be read";
  return null;
}

/** The shop card's lines, in words. Only "takesOrders" says whether orders are possible; the other lines describe one setting each. */
export function shopLines(
  status: SiteShopStatus,
  live: boolean | null,
  time: (ms: number) => string,
): { takesOrders: string; orders: string; allShops: string; address: string; counts: string } {
  const why = orderBlocker(status, live);
  return {
    takesOrders: why === null ? "Yes" : `No: ${why}`,
    orders: status.ordersPausedAt === null ? "Not paused" : `Paused by ${staffName(status.ordersPausedBy ?? "")} on ${time(status.ordersPausedAt)}`,
    allShops: status.allOrdersPaused ? "Paused for every shop" : "Not paused",
    address:
      status.orderEmail === null
        ? "None yet. Orders can't be placed."
        : status.orderEmailConfirmedAt === null
          ? `${status.orderEmail}: not confirmed yet. Orders can't be placed until it is.`
          : `${status.orderEmail}: confirmed ${time(status.orderEmailConfirmedAt)}${status.orderEmailConfirmedBy === null ? "" : ` by ${staffName(status.orderEmailConfirmedBy)}`}`,
    counts: `${status.orderCount} in all · ${status.ordersToday} today (UTC)`,
  };
}

/** What Resume says, from the status read back after it: "takes orders again" only when the insert guard would let an order in. */
export function resumedText(status: SiteShopStatus, live: boolean | null): string {
  if (status.ordersPausedAt !== null) return "Orders are still paused for this site.";
  const why = orderBlocker(status, live);
  return why === null ? "This site takes orders again." : `This site's own pause is off, but it can't take orders: ${why}.`;
}

/** The every-shop switch's words: they describe the switch only, never promise that any shop takes orders. */
export const ALL_PAUSED_TEXT = "Orders are paused on every shop.";
export const ALL_NOT_PAUSED_TEXT = "Orders are not paused on every shop.";
export const ALL_RESUMED_TEXT = "The every-shop pause is off. Shops paused on their own stay paused.";

/** The 409 line shown after the page reloaded the state it changed. */
export const CHANGED_ELSEWHERE = "This order changed while you were looking. It now shows its latest state.";
export const SHOP_CHANGED_ELSEWHERE = "Someone else changed this just now. It shows the latest state.";
/** A POST that got no clear answer (network, 5xx) may have committed: never claim either way. */
export const UNSURE = "We couldn't tell whether that worked. Reload to see the latest state.";
