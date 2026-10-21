// A local mirror of the input types of Plan 3's cart-markup module (@asksite/renderer/cart-markup), as cart-markup.md rev 3
// §1 defines them, until that module merges; then these come from the module and this file goes. Changes only through the
// moderator. The Worker prices, validates and decides; the module only writes the markup.

/** The shop contract's FULFILMENT (§2.4), in its order. */
export const FULFILMENT = ["pickup", "delivery", "shipping"] as const;
export type Fulfilment = (typeof FULFILMENT)[number];

/** The order fields a buyer types, which the form may refill after an error (never the honeypot or the quote). */
export const REFILLED_FIELDS = ["name", "email", "phone", "line1", "line2", "city", "state", "zip", "note"] as const;
export type RefilledField = (typeof REFILLED_FIELDS)[number];

export interface CartLineInput {
  readonly productId: string;
  readonly variantId?: string;
  readonly slug: string;
  readonly name: string;
  readonly variantLabel?: string;
  readonly unitCents: number;
  readonly compareAtCents?: number;
  readonly qty: number;
  readonly maxQty: number;
  readonly lineCents: number;
}

export type CartNotice = "added" | "updated" | "removed" | "items_removed" | "prices_changed";

export type OrderErrorCode =
  | "required" | "too_long" | "email_invalid" | "phone_invalid" | "state_invalid" | "zip_invalid"
  | "fulfilment_invalid" | "address_required" | "name_invalid";
export interface OrderError {
  readonly field: RefilledField | "fulfilment";
  readonly code: OrderErrorCode;
}

/** The buyer's typed values to refill after an error. `phone` only in the +1 form (rev 3), or left out. */
export type OrderRefill = Partial<Record<RefilledField, string>> & { readonly fulfilment?: Fulfilment };

export interface CartSlotInput {
  readonly siteId: string;
  readonly lines: readonly CartLineInput[];
  readonly subtotalCents: number;
  readonly notices?: readonly CartNotice[];
  readonly fulfilment: readonly Fulfilment[];
  readonly orderNote?: string;
  readonly quote: string;
  readonly refill?: OrderRefill;
  readonly errors?: readonly OrderError[];
}

export interface SentLineInput {
  readonly name: string;
  readonly variantLabel?: string;
  readonly qty: number;
  readonly lineCents: number;
}
export interface SentSlotInput {
  readonly businessName: string;
  readonly order?: {
    readonly number: number;
    readonly lines: readonly SentLineInput[];
    readonly subtotalCents: number;
    readonly fulfilment: Fulfilment;
  };
}

export type RefusalReason = "rate_limited" | "orders_paused" | "daily_cap" | "order_too_large" | "cart_too_large" | "not_available";
export interface RefusalSlotInput {
  readonly reason: RefusalReason;
  readonly businessName: string;
  readonly phone?: string;
}
