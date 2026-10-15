import type { MouseEvent } from "react";
import { PhoneLink, SafeLink } from "../components/contact-links.tsx";
import { formatUsd } from "../lib/money.ts";
import { buyerMailto, orderTime, PAYMENT_TEXT, STATUS_WORD, type OrderStatus, type OrderView } from "./orders.ts";

interface Props {
  order: OrderView;
  businessName: string;
  backHref: string;
  onBack: (event: MouseEvent<HTMLAnchorElement>) => void;
  /** Marks the order done, or new again; `busy` while that is saving, and `message` says how it went. */
  onSetStatus: (status: OrderStatus) => void;
  busy: boolean;
  message: string;
}

/**
 * One order: what was ordered (each line's price and total as the server stored them, never added up here), how payment works,
 * the buyer's details as typed (links only when safe), their note, and Mark as done / Mark as new.
 */
export function OrderDetail({ order, ...props }: Props) {
  const mailto = buyerMailto(order, props.businessName);
  const done = order.status === "done";
  return (
    <section aria-labelledby="order-title">
      <a href={props.backHref} onClick={props.onBack} className="link back-link">
        <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        All orders
      </a>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h2 id="order-title" className="section-title">
          Order #{order.number}
        </h2>
        <span className={order.status === "new" ? "pill-brand" : "pill"}>{STATUS_WORD[order.status]}</span>
      </div>
      <p className="meta mt-1 text-sm">{orderTime(order.createdAt)}</p>

      <div className="card mt-5">
        <h3 id="order-items" className="font-semibold text-ink">
          Items
        </h3>
        <div className="table-scroll mt-3" role="region" aria-labelledby="order-items" tabIndex={0}>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className="text-right">
                  Quantity
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
              {order.lines.map((line, i) => (
                <tr key={i}>
                  <th scope="row" className="break-words">
                    {line.name}
                    {line.choice !== null ? <span className="block text-sm font-normal text-slate-600">{line.choice}</span> : null}
                  </th>
                  <td className="text-right tabular-nums">{line.quantity}</td>
                  <td className="money font-normal">{formatUsd(line.unitCents, "exact")}</td>
                  <td className="money">{formatUsd(line.lineCents, "exact")}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={3} className="text-right">
                  Order total
                </th>
                <td className="money">{formatUsd(order.totalCents, "exact")}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p className="mt-4 text-slate-700">{PAYMENT_TEXT[order.payment]}</p>
      </div>

      <div className="card mt-4">
        <h3 className="font-semibold text-ink">Buyer</h3>
        <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[8rem_1fr]">
          <dt className="text-slate-600">Name</dt>
          <dd className="break-words">{order.buyer.name}</dd>
          {order.buyer.email !== null ? (
            <>
              <dt className="text-slate-600">Email</dt>
              <dd>{mailto !== null ? <SafeLink href={mailto} text={order.buyer.email} /> : <span className="break-all">{order.buyer.email}</span>}</dd>
            </>
          ) : null}
          {order.buyer.phone !== null ? (
            <>
              <dt className="text-slate-600">Phone</dt>
              <dd>
                <PhoneLink phone={order.buyer.phone} />
              </dd>
            </>
          ) : null}
          {order.buyer.address !== null ? (
            <>
              <dt className="text-slate-600">Address</dt>
              <dd className="whitespace-pre-line break-words">{order.buyer.address}</dd>
            </>
          ) : null}
          {order.note !== null ? (
            <>
              <dt className="text-slate-600">Note</dt>
              <dd className="whitespace-pre-line break-words">{order.note}</dd>
            </>
          ) : null}
        </dl>
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        <button type="button" className={done ? "btn-secondary" : "btn-primary"} aria-disabled={props.busy} onClick={() => (props.busy ? undefined : props.onSetStatus(done ? "new" : "done"))}>
          {props.busy ? "Saving…" : done ? "Mark as new" : "Mark as done"}
        </button>
      </div>
      <p role="status" className="mt-3 text-slate-700">
        {props.message}
      </p>
    </section>
  );
}
