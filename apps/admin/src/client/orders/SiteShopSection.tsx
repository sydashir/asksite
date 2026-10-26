import type { SiteShopStatus } from "@asksite/core";
import { useEffect, useRef, useState } from "react";
import { Notice } from "../../../../app/src/client/components/feedback.tsx";
import { onLinkClick } from "../../../../app/src/client/hooks/use-route.ts";
import { api } from "../../../../app/src/client/lib/api.ts";
import { useResource } from "../hooks.ts";
import { ShopStatusCard } from "./ShopStatusCard.tsx";
import { ordersPath, SHOP_CHANGED_ELSEWHERE, UNSURE } from "./words.ts";

type Message = { tone: "success" | "error"; text: string };

/**
 * Loads a site's shop status and runs its pause and resume. A 409 means someone else changed it first: the card reloads and says
 * so. No answer, or a server error, may still have changed it: the card reloads and says it could not tell. `onStatus` passes the
 * loaded status up (the Orders page reads the every-shop pause from it).
 */
export function SiteShopSection(props: { siteId: string; siteName: string; showOrdersLink: boolean; onStatus?: (status: SiteShopStatus) => void }) {
  const { load, reload } = useResource<SiteShopStatus>(`/api/admin/sites/${props.siteId}/shop`);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);
  const messageRef = useRef<HTMLDivElement>(null);
  const { onStatus } = props;
  useEffect(() => {
    if (load.state === "ready") onStatus?.(load.data);
  }, [load, onStatus]);

  async function setPaused(paused: boolean) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    try {
      const res = await api<{ ordersPaused: boolean }>("POST", `/api/admin/sites/${props.siteId}/orders/${paused ? "pause" : "resume"}`, {});
      await reload();
      if (res.ok) setMessage({ tone: "success", text: paused ? "Orders paused for this site." : "This site takes orders again." });
      else if (res.status === 409) setMessage({ tone: "error", text: SHOP_CHANGED_ELSEWHERE });
      else if (res.status === 0 || res.status >= 500) setMessage({ tone: "error", text: UNSURE });
      else setMessage({ tone: "error", text: res.error.message });
      requestAnimationFrame(() => messageRef.current?.focus());
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  if (load.state === "loading")
    return (
      <p role="status" className="loading mt-4">
        <span className="spinner" aria-hidden="true" />
        Loading the shop…
      </p>
    );
  if (load.state === "error")
    return (
      <div role="alert">
        <Notice tone="error">
          {load.error.message}
          <button type="button" className="btn-secondary mt-3 flex" onClick={() => void reload()}>
            Try again
          </button>
        </Notice>
      </div>
    );
  return (
    <ShopStatusCard
      status={load.data}
      siteName={props.siteName}
      ordersHref={props.showOrdersLink ? ordersPath({ siteId: props.siteId, spam: false }) : null}
      onLink={onLinkClick}
      busy={busy}
      message={message !== null ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      messageRef={messageRef}
      onPause={() => void setPaused(true)}
      onResume={() => void setPaused(false)}
    />
  );
}
