import type { MouseEvent } from "react";
import { Notice } from "../components/feedback.tsx";
import { formatUsd } from "../lib/money.ts";
import { emptyOrdersText, filterLabel, linesSummary, ORDER_FILTERS, orderTime, STATUS_WORD, type OrderFilter, type OrderSummary } from "./orders.ts";

interface Props {
  orders: readonly OrderSummary[];
  filter: OrderFilter;
  /** How many orders each filter holds, when the server says (shown on the buttons, e.g. "New (2)"). */
  counts: Partial<Record<OrderFilter, number>>;
  onFilter: (filter: OrderFilter) => void;
  /** Each order is a link to its own page; the container's click handler keeps the navigation in the app. */
  hrefFor: (id: string) => string;
  onOpen: (event: MouseEvent<HTMLAnchorElement>) => void;
  businessName: string;
  state: "loading" | "error" | "ready";
  errorMessage?: string;
  onRetry: () => void;
}

/**
 * Orders from the website, newest first, with a filter (New, Open, Done, All). Each row is one link to the order: its state in
 * words, number, buyer, time, the first item and how many more, and the total the server stored.
 */
export function OrderList(props: Props) {
  return (
    <section aria-labelledby="orders-title">
      <h2 id="orders-title" className="section-title">
        Orders
      </h2>
      <div role="group" aria-label="Show" className="mt-3 flex flex-wrap gap-2">
        {ORDER_FILTERS.map((f) => (
          <button key={f.id} type="button" className="btn-small" aria-pressed={props.filter === f.id} onClick={() => props.onFilter(f.id)}>
            {filterLabel(f.id, props.counts[f.id])}
          </button>
        ))}
      </div>

      {props.state === "loading" ? (
        <p role="status" className="loading mt-4">
          <span className="spinner" aria-hidden="true" />
          Loading the orders…
        </p>
      ) : null}
      {props.state === "error" ? (
        <div role="alert">
          <Notice tone="error">
            {props.errorMessage ?? "We couldn't load the orders."}
            <button type="button" className="btn-secondary mt-3 flex" onClick={props.onRetry}>
              Try again
            </button>
          </Notice>
        </div>
      ) : null}
      {props.state === "ready" && props.orders.length === 0 ? (
        <div className="empty-state mt-4">
          <p className="text-slate-700">{emptyOrdersText(props.filter, props.businessName)}</p>
        </div>
      ) : null}

      {props.state === "ready" && props.orders.length > 0 ? (
        <ul className="mt-4 divide-y divide-slate-100 rounded-card border border-slate-200 bg-white">
          {props.orders.map((order) => (
            <li key={order.id}>
              <a href={props.hrefFor(order.id)} onClick={props.onOpen} className="order-row">
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className={order.status === "new" ? "pill-brand" : "pill"}>{STATUS_WORD[order.status]}</span>
                  <span className="font-semibold text-ink">Order #{order.number}</span>
                  <span className="text-slate-700">{order.buyerName}</span>
                  <span className="text-sm text-slate-600">{orderTime(order.createdAt)}</span>
                </span>
                <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="min-w-0 break-words text-slate-700">{linesSummary(order.lines)}</span>
                  <span className="money">{formatUsd(order.totalCents, "exact")}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
