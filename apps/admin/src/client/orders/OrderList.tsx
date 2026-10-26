import type { OrderListItem } from "@asksite/core";
import { useEffect, useRef, type MouseEvent } from "react";
import { Notice } from "../../../../app/src/client/components/feedback.tsx";
import { formatUsd } from "../../../../app/src/client/lib/money.ts";
import { when } from "../lib/format.ts";
import { emailLine, orderSiteLabel, STATUS_WORD } from "./words.ts";

interface Props {
  orders: readonly OrderListItem[];
  emptyText: string;
  /** Each order is a link to its own page; `onOpen` keeps the navigation in the app (onLinkClick). */
  hrefFor: (id: string) => string;
  onOpen: (event: MouseEvent<HTMLAnchorElement>) => void;
  /** The server has older orders. */
  hasMore: boolean;
  loadingOlder: boolean;
  olderError: string | null;
  onLoadOlder: () => void;
  /** The first row of the last page loaded: it takes focus when "Show older orders" goes away, so focus is not lost. */
  focusId: string | null;
}

/**
 * Orders, newest first. Each row is one link: its state in words, number, site, buyer, time, the subtotal the server stored and
 * what happened to the client's email. Older orders come a page at a time.
 */
export function OrderList(props: Props) {
  const focusRow = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (props.focusId !== null) focusRow.current?.focus();
  }, [props.focusId]);

  if (props.orders.length === 0) {
    return (
      <div className="empty-state mt-6">
        <p className="text-slate-700">{props.emptyText}</p>
      </div>
    );
  }
  return (
    <>
      <ul className="mt-6 divide-y divide-slate-100 rounded-card border border-slate-200 bg-white">
        {props.orders.map((order) => (
          <li key={order.id}>
            <a ref={order.id === props.focusId ? focusRow : undefined} href={props.hrefFor(order.id)} onClick={props.onOpen} className="order-row">
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className={order.status === "new" ? "pill-brand" : "pill"}>{STATUS_WORD[order.status]}</span>
                {order.spam ? <span className="pill">Spam</span> : null}
                <span className="font-semibold text-ink">Order #{order.number}</span>
                <span className="text-slate-700 [overflow-wrap:anywhere]">{order.name}</span>
                <span className="money ml-auto">{formatUsd(order.subtotalCents, "exact")}</span>
              </span>
              <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-slate-600">
                <span className="[overflow-wrap:anywhere]">{orderSiteLabel(order)}</span>
                <span>{when(order.createdAt)}</span>
                <span className={order.emailStatus === "failed" ? "font-medium text-red-700" : undefined}>{emailLine(order.emailStatus, order.emailError)}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
      {props.olderError !== null ? (
        <div role="alert">
          <Notice tone="error">{props.olderError}</Notice>
        </div>
      ) : null}
      {props.hasMore ? (
        <button
          type="button"
          className="btn-secondary mt-4"
          aria-disabled={props.loadingOlder}
          aria-busy={props.loadingOlder}
          onClick={() => (props.loadingOlder ? undefined : props.onLoadOlder())}
        >
          {props.loadingOlder ? "Loading older orders…" : "Show older orders"}
        </button>
      ) : null}
    </>
  );
}
