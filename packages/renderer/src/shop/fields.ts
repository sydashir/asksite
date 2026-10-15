// The names of the shop forms' fields and the forms' own limits: the one place they are written, so phase 2 changes
// them here if the pages lane's endpoints (pages-proposal §1.3, §1.6) name them otherwise. The endpoints check every
// value again; these limits only shape the form (maxlength, the hints).

/** The cart endpoint's fields (POST /_cart, pages-proposal §1.3). */
export const CART_FIELD = { op: "op", product: "product", variant: "variant", qty: "qty" } as const;

/** The cart endpoint's operations. */
export const CART_OP = { add: "add", set: "set", remove: "remove" } as const;

/** The order endpoint's fields (POST /_o/<siteId>, pages-proposal §1.6). */
export const ORDER_FIELD = {
  name: "name",
  email: "email",
  phone: "phone",
  fulfilment: "fulfilment",
  line1: "line1",
  line2: "line2",
  city: "city",
  state: "state",
  zip: "zip",
  note: "note",
  /** Off-screen, out of the tab order and hidden from assistive tech: people never fill it, bots do. */
  honeypot: "website",
  /** Hidden: the cart page's quote hash (pages-proposal §1.5 step 6). A check, never a price source. */
  quote: "quote",
} as const;

/** The order fields a buyer types, which the form may refill after an error (moderator ruling, ADDENDUM 3). */
export const REFILLED_FIELDS = ["name", "email", "phone", "line1", "line2", "city", "state", "zip", "note"] as const;
export type RefilledField = (typeof REFILLED_FIELDS)[number];

/** maxlength of each typed order field: the lead rules for name and phone (apps/sites lead.ts), the rest pages-proposal §1.6. */
export const ORDER_MAX_LENGTH: Readonly<Record<RefilledField, number>> = { name: 80, email: 254, phone: 30, line1: 80, line2: 80, city: 40, state: 2, zip: 5, note: 1000 };
