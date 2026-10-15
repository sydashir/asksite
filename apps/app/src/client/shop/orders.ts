// The order screens' own rules and words, kept out of the components so they are tested on their own. Every amount comes from
// the order the server stored; nothing here adds up money.

export type OrderStatus = "new" | "open" | "done";
export type OrderFilter = OrderStatus | "all";

/** One line of an order, as the server stored it. */
export interface OrderLine {
  name: string;
  /** The buyer's choice, e.g. "Size 8" (null when the product has none). */
  choice: string | null;
  quantity: number;
  unitCents: number;
  lineCents: number;
}

export interface OrderSummary {
  id: string;
  number: number;
  createdAt: number;
  buyerName: string;
  lines: OrderLine[];
  totalCents: number;
  status: OrderStatus;
}

export interface OrderBuyer {
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
}

export interface OrderView extends OrderSummary {
  buyer: OrderBuyer;
  note: string | null;
  /** Step 1 has no card payments; step 2 adds the other two. */
  payment: "not-online" | "paid" | "refunded";
}

export const ORDER_FILTERS: ReadonlyArray<{ id: OrderFilter; label: string }> = [
  { id: "new", label: "New" },
  { id: "open", label: "Open" },
  { id: "done", label: "Done" },
  { id: "all", label: "All" },
];

export const STATUS_WORD: Record<OrderStatus, string> = { new: "New", open: "Open", done: "Done" };

/** When the order came in, as the Messages page writes it: "Oct 15, 2026, 2:14 PM". */
export const orderTime = (ms: number): string => new Date(ms).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

/** "Mom Flipflop (Size 8) × 2" */
export function lineText(line: Pick<OrderLine, "name" | "choice" | "quantity">): string {
  return `${line.name}${line.choice === null ? "" : ` (${line.choice})`} × ${line.quantity}`;
}

/** The first line and how many more: "Mom Flipflop (Size 8) × 2 and 1 more". */
export function linesSummary(lines: readonly OrderLine[]): string {
  const first = lines[0];
  if (first === undefined) return "No items";
  return lines.length === 1 ? lineText(first) : `${lineText(first)} and ${lines.length - 1} more`;
}

/** The filter button's words, with the count where it helps: "New (2)". */
export function filterLabel(filter: OrderFilter, count: number | undefined): string {
  const label = ORDER_FILTERS.find((f) => f.id === filter)!.label;
  return count === undefined ? label : `${label} (${count})`;
}

export const PAYMENT_TEXT: Record<OrderView["payment"], string> = {
  "not-online": "Not paid online. The business arranges payment and delivery with the buyer.",
  paid: "Paid by card.",
  refunded: "Refunded.",
};

/** What the list says when a filter has no orders. */
export function emptyOrdersText(filter: OrderFilter, businessName: string): string {
  switch (filter) {
    case "all":
      return `No orders yet. When someone orders from the website, it shows up here and ${businessName} gets an email.`;
    case "new":
      return "No new orders. Orders you have opened are under Open.";
    case "open":
      return "No open orders.";
    case "done":
      return "No orders marked as done yet.";
  }
}

/**
 * A mailto link for the buyer, with the order in the subject. Null when there is no email, or when the buyer's text could add
 * its own parts to the link (a "?", "&", "#", "%" or a space): the address is then shown as text only.
 */
export function buyerMailto(order: Pick<OrderView, "number" | "buyer">, businessName: string): string | null {
  if (order.buyer.email === null || /[?&#%\s]/.test(order.buyer.email)) return null;
  return `mailto:${order.buyer.email}?subject=${encodeURIComponent(`Your order #${order.number} from ${businessName}`)}`;
}
