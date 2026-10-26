import type { OrderDetail as OrderDetailView } from "@asksite/core";
import { useRef, useState } from "react";
import { Notice } from "../../../../app/src/client/components/feedback.tsx";
import { usePageHeading } from "../../../../app/src/client/hooks/use-page-heading.ts";
import { onLinkClick } from "../../../../app/src/client/hooks/use-route.ts";
import { api } from "../../../../app/src/client/lib/api.ts";
import { useResource } from "../hooks.ts";
import { ordersBackHref } from "../orders/back.ts";
import { OrderDetail } from "../orders/OrderDetail.tsx";
import { CHANGED_ELSEWHERE, UNSURE } from "../orders/words.ts";

type Message = { tone: "success" | "error"; text: string };

/** One order for staff (admin-orders-plan.md §3.3). */
export function Order({ orderId }: { orderId: string }) {
  const { load, reload } = useResource<OrderDetailView>(`/api/admin/orders/${orderId}`);
  if (load.state === "loading")
    return (
      <p role="status" className="loading">
        <span className="spinner" aria-hidden="true" />
        Loading the order…
      </p>
    );
  if (load.state === "error") return <OrderLoadError code={load.error.code} message={load.error.message} retry={() => void reload()} />;
  return <OrderScreen order={load.data} reload={reload} />;
}

function OrderLoadError({ code, message, retry }: { code: string; message: string; retry: () => void }) {
  const heading = usePageHeading<HTMLHeadingElement>("Order", "Admin");
  return (
    <section>
      <h1 ref={heading} tabIndex={-1} className="page-title">
        Order
      </h1>
      <div role="alert">
        {code === "not_found" ? (
          <Notice tone="error">This order no longer exists.</Notice>
        ) : (
          <Notice tone="error">
            We couldn't load the order. {message}
            <button type="button" className="btn-secondary mt-3 flex" onClick={retry}>
              Try again
            </button>
          </Notice>
        )}
      </div>
      <p className="mt-4">
        <a href={ordersBackHref()} onClick={onLinkClick} className="link">
          All orders
        </a>
      </p>
    </section>
  );
}

function OrderScreen({ order, reload }: { order: OrderDetailView; reload: () => Promise<void> }) {
  const heading = usePageHeading<HTMLHeadingElement>(`Order #${order.number}`, "Admin");
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);
  const messageRef = useRef<HTMLDivElement>(null);

  /**
   * Cancel or mark as spam. The server changes the order only from the state staff saw (409 otherwise): then the order reloads
   * and the page says it changed. No answer or a server error may still have changed it: the order reloads and the page says
   * it could not tell. Nothing is ever sent again on its own.
   */
  async function change(action: "cancel" | "spam") {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    try {
      const res = await api("POST", `/api/admin/orders/${order.id}/${action}`, {});
      await reload();
      if (res.ok) setMessage({ tone: "success", text: action === "cancel" ? "Order cancelled." : "Marked as spam." });
      else if (res.status === 409) setMessage({ tone: "error", text: CHANGED_ELSEWHERE });
      else if (res.status === 0 || res.status >= 500) setMessage({ tone: "error", text: UNSURE });
      else setMessage({ tone: "error", text: res.error.message });
      requestAnimationFrame(() => messageRef.current?.focus());
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  return (
    <OrderDetail
      order={order}
      headingRef={heading}
      backHref={ordersBackHref()}
      siteHref={`/sites/${order.siteId}`}
      onLink={onLinkClick}
      message={message !== null ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      messageRef={messageRef}
      busy={busy}
      onCancel={() => void change("cancel")}
      onSpam={() => void change("spam")}
    />
  );
}
