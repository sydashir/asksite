// What the staff orders API answers (pages lane proposal 1.9): the admin's orders screens read these.

export type OrderStatus = "new" | "cancelled";
export type OrderEmailStatus = "pending" | "sent" | "failed" | "skipped" | "held";
export type OrderFulfilment = "pickup" | "delivery" | "shipping";

export interface OrderListItem {
  id: string;
  siteId: string;
  slug: string | null;
  number: number;
  createdAt: number;
  /** The buyer's name: staff see it in the list. */
  name: string;
  subtotalCents: number;
  status: OrderStatus;
  spam: boolean;
  emailStatus: OrderEmailStatus;
  emailError: string | null;
}

export interface OrderItemView {
  name: string;
  variantLabel: string | null;
  unitCents: number;
  qty: number;
  lineCents: number;
}

export interface OrderDetail extends OrderListItem {
  email: string;
  phone: string | null;
  fulfilment: OrderFulfilment;
  address: { line1: string; line2?: string; city: string; state: string; zip: string } | null;
  note: string | null;
  items: OrderItemView[];
  statusAt: number | null;
  statusBy: string | null;
}

/** A site's shop status for staff: the orders pause, the client order address and its confirmation, counts. */
export interface SiteShopStatus {
  ordersPausedAt: number | null;
  ordersPausedBy: string | null;
  allOrdersPaused: boolean;
  orderEmail: string | null;
  orderEmailRev: number;
  orderEmailConfirmedAt: number | null;
  orderEmailConfirmedBy: string | null;
  orderCount: number;
  ordersToday: number;
}
