import type { SiteShopStatus } from "@asksite/core";
import { useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { ConfirmDialog } from "../../../../app/src/client/components/dialog.tsx";
import { when } from "../lib/format.ts";
import { shopLines } from "./words.ts";

interface Props {
  status: SiteShopStatus;
  /** How the site is named in the pause dialog (its web address, or its business name). */
  siteName: string;
  /** "See this site's orders" (the site page shows it; the Orders list, already filtered, does not). */
  ordersHref: string | null;
  onLink: (event: MouseEvent<HTMLAnchorElement>) => void;
  busy: boolean;
  message: ReactNode;
  messageRef: RefObject<HTMLDivElement | null>;
  /** Called after the staff member confirmed. */
  onPause: () => void;
  onResume: () => void;
}

/**
 * A site's shop for staff: whether it takes orders (paused here, or for every shop), the client's order address and whether it
 * is confirmed (a shop takes orders only while it is), and how many orders it has. Pausing asks first; resuming does not.
 */
export function ShopStatusCard({ status, ...props }: Props) {
  const [confirming, setConfirming] = useState(false);
  const lines = shopLines(status, when);
  const paused = status.ordersPausedAt !== null;
  return (
    <section className="card" aria-labelledby="shop-title">
      <h2 id="shop-title" className="section-title">
        Shop
      </h2>
      <div ref={props.messageRef} role="status" tabIndex={-1}>
        {props.message}
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[9rem_1fr]">
        <dt className="text-slate-600">This site</dt>
        <dd className="[overflow-wrap:anywhere]">{lines.orders}</dd>
        <dt className="text-slate-600">All shops</dt>
        <dd>{lines.allShops}</dd>
        <dt className="text-slate-600">Order address</dt>
        <dd className="[overflow-wrap:anywhere]">{lines.address}</dd>
        <dt className="text-slate-600">Orders</dt>
        <dd>{lines.counts}</dd>
      </dl>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {paused ? (
          <button type="button" className="btn-secondary" aria-disabled={props.busy} onClick={() => (props.busy ? undefined : props.onResume())}>
            Resume this site's orders
          </button>
        ) : (
          <button type="button" className="btn-secondary" aria-disabled={props.busy} onClick={() => (props.busy ? undefined : setConfirming(true))}>
            Pause this site's orders
          </button>
        )}
        {props.ordersHref !== null ? (
          <a href={props.ordersHref} onClick={props.onLink} className="link">
            See this site's orders
          </a>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        title={`Pause orders for ${props.siteName}?`}
        confirmLabel="Pause orders"
        cancelLabel="Keep taking orders"
        onConfirm={() => {
          setConfirming(false);
          props.onPause();
        }}
        onCancel={() => setConfirming(false)}
      >
        <p>Buyers see that ordering is paused. Orders already placed stay.</p>
      </ConfirmDialog>
    </section>
  );
}
