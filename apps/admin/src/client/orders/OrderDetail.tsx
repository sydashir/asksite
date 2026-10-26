import type { OrderDetail as OrderDetailView } from "@asksite/core";
import { useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { PhoneLink, SafeLink } from "../../../../app/src/client/components/contact-links.tsx";
import { ConfirmDialog } from "../../../../app/src/client/components/dialog.tsx";
import { formatUsd } from "../../../../app/src/client/lib/money.ts";
import { when } from "../lib/format.ts";
import { addressLines, buyerMailto, emailLine, FULFILMENT_WORD, orderSiteLabel, STATUS_WORD, statusChangeText } from "./words.ts";

interface Props {
  order: OrderDetailView;
  headingRef: RefObject<HTMLHeadingElement | null>;
  backHref: string;
  siteHref: string;
  /** In-app links (onLinkClick). */
  onLink: (event: MouseEvent<HTMLAnchorElement>) => void;
  /** The result of the last action (or the 409 line), shown in the status region that takes focus. */
  message: ReactNode;
  messageRef: RefObject<HTMLDivElement | null>;
  busy: boolean;
  /** Called after the staff member confirmed. */
  onCancel: () => void;
  onSpam: () => void;
}

function Back({ href, onLink }: { href: string; onLink: Props["onLink"] }) {
  return (
    <a href={href} onClick={onLink} className="link back-link">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 18l-6-6 6-6" />
      </svg>
      All orders
    </a>
  );
}

/**
 * One order as the server stored it: the lines and subtotal (never added up here), how the buyer gets it, the buyer's details as
 * they typed them (links only when safe), the client's email, and Cancel / Mark as spam behind a confirmation each.
 */
export function OrderDetail({ order, ...props }: Props) {
  const [confirming, setConfirming] = useState<"cancel" | "spam" | null>(null);
  const mailto = buyerMailto(order);
  const change = statusChangeText(order, when);
  return (
    <section>
      <p>
        <Back href={props.backHref} onLink={props.onLink} />
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <h1 ref={props.headingRef} tabIndex={-1} className="page-title">
          Order #{order.number}
        </h1>
        <span className={order.status === "new" ? "pill-brand" : "pill"}>{STATUS_WORD[order.status]}</span>
        {order.spam ? <span className="pill">Spam</span> : null}
      </div>
      <p className="meta mt-2">
        <a href={props.siteHref} onClick={props.onLink} className="link [overflow-wrap:anywhere]">
          {orderSiteLabel(order)}
        </a>{" "}
        · {when(order.createdAt)}
      </p>
      {change !== null ? <p className="mt-1 text-sm text-slate-700 [overflow-wrap:anywhere]">{change}</p> : null}
      <div ref={props.messageRef} role="status" tabIndex={-1}>
        {props.message}
      </div>

      <div className="card mt-6">
        <h2 id="order-items" className="section-title">
          Items
        </h2>
        <div className="table-scroll mt-3" role="region" aria-labelledby="order-items" tabIndex={0}>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className="text-right">
                  Qty
                </th>
                <th scope="col" className="text-right">
                  Price
                </th>
                <th scope="col" className="text-right">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item, i) => (
                <tr key={i}>
                  <th scope="row" className="[overflow-wrap:anywhere]">
                    {item.name}
                    {item.variantLabel !== null ? <span className="block text-sm font-normal text-slate-600">{item.variantLabel}</span> : null}
                  </th>
                  <td className="text-right tabular-nums">{item.qty}</td>
                  <td className="money font-normal">{formatUsd(item.unitCents, "exact")}</td>
                  <td className="money">{formatUsd(item.lineCents, "exact")}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={3} className="text-right">
                  Subtotal
                </th>
                <td className="money">{formatUsd(order.subtotalCents, "exact")}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="mt-4 text-slate-700">Not paid online. The client arranges payment and delivery with the buyer.</p>
      </div>

      <div className="card mt-4">
        <h2 className="section-title">Buyer</h2>
        <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[11rem_1fr]">
          <dt className="text-slate-600">Name</dt>
          <dd className="[overflow-wrap:anywhere]">{order.name}</dd>
          <dt className="text-slate-600">Email</dt>
          <dd>{mailto !== null ? <SafeLink href={mailto} text={order.email} /> : <span className="[overflow-wrap:anywhere]">{order.email}</span>}</dd>
          {order.phone !== null ? (
            <>
              <dt className="text-slate-600">Phone</dt>
              <dd>
                <PhoneLink phone={order.phone} />
              </dd>
            </>
          ) : null}
          <dt className="text-slate-600">Getting the order</dt>
          <dd>
            {FULFILMENT_WORD[order.fulfilment]}
            {order.address !== null
              ? addressLines(order.address).map((line, i) => (
                  <span key={i} className="block [overflow-wrap:anywhere]">
                    {line}
                  </span>
                ))
              : null}
          </dd>
          {order.note !== null ? (
            <>
              <dt className="text-slate-600">Note</dt>
              <dd className="whitespace-pre-line [overflow-wrap:anywhere]">{order.note}</dd>
            </>
          ) : null}
          <dt className="text-slate-600">Email to the client</dt>
          <dd className={order.emailStatus === "failed" ? "font-medium text-red-700" : undefined}>{emailLine(order.emailStatus, order.emailError)}</dd>
        </dl>
      </div>

      {order.status === "new" || !order.spam ? (
        <div className="mt-6 flex flex-wrap gap-3">
          {order.status === "new" ? (
            <button type="button" className="btn-danger" aria-disabled={props.busy} onClick={() => (props.busy ? undefined : setConfirming("cancel"))}>
              Cancel this order
            </button>
          ) : null}
          {!order.spam ? (
            <button type="button" className="btn-secondary" aria-disabled={props.busy} onClick={() => (props.busy ? undefined : setConfirming("spam"))}>
              Mark as spam
            </button>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming === "cancel"}
        title={`Cancel order #${order.number}?`}
        confirmLabel="Cancel the order"
        cancelLabel="Keep it"
        danger
        onConfirm={() => {
          setConfirming(null);
          props.onCancel();
        }}
        onCancel={() => setConfirming(null)}
      >
        <p>The buyer is not told automatically. Let them know, or ask the client to.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirming === "spam"}
        title={`Mark order #${order.number} as spam?`}
        confirmLabel="Mark as spam"
        cancelLabel="Keep it"
        danger
        onConfirm={() => {
          setConfirming(null);
          props.onSpam();
        }}
        onCancel={() => setConfirming(null)}
      >
        <p>It moves to the Spam list. This can't be undone here.</p>
      </ConfirmDialog>
    </section>
  );
}
