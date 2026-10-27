import type { SiteShopStatus } from "@asksite/core";
import { useEffect, useRef, useState } from "react";
import { Notice } from "../../../../app/src/client/components/feedback.tsx";
import { onLinkClick } from "../../../../app/src/client/hooks/use-route.ts";
import { api } from "../../../../app/src/client/lib/api.ts";
import { useResource } from "../hooks.ts";
import { ShopStatusCard } from "./ShopStatusCard.tsx";
import { orderBlocker, ordersPath, resumedText, SHOP_CHANGED_ELSEWHERE, UNSURE } from "./words.ts";

/** The last action's result. "resumed" is worded from the status read back after it (resumedText), so it is always true. */
type Result = { kind: "paused" } | { kind: "resumed" } | { kind: "error"; text: string };

/**
 * Loads a site's shop status and runs its pause and resume. A 409 means someone else changed it first: the card reloads and says
 * so. No answer, or a server error, may still have changed it: the card reloads and says it could not tell. `onStatus` passes the
 * loaded status up (the Orders page reads the every-shop pause from it).
 */
export function SiteShopSection(props: { siteId: string; siteName: string; live: boolean | null; showOrdersLink: boolean; onStatus?: (status: SiteShopStatus) => void }) {
  const { load, reload } = useResource<SiteShopStatus>(`/api/admin/sites/${props.siteId}/shop`);
  const [result, setResult] = useState<Result | null>(null);
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
      if (res.ok) setResult({ kind: paused ? "paused" : "resumed" });
      else if (res.status === 409) setResult({ kind: "error", text: SHOP_CHANGED_ELSEWHERE });
      else if (res.status === 0 || res.status >= 500) setResult({ kind: "error", text: UNSURE });
      else setResult({ kind: "error", text: res.error.message });
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
      live={props.live}
      siteName={props.siteName}
      ordersHref={props.showOrdersLink ? ordersPath({ siteId: props.siteId, spam: false }) : null}
      onLink={onLinkClick}
      busy={busy}
      message={
        result === null ? null : result.kind === "error" ? (
          <Notice tone="error">{result.text}</Notice>
        ) : result.kind === "paused" ? (
          <Notice tone="success">Orders paused for this site.</Notice>
        ) : (
          <Notice tone={orderBlocker(load.data, props.live) === null ? "success" : "warning"}>{resumedText(load.data, props.live)}</Notice>
        )
      }
      messageRef={messageRef}
      onPause={() => void setPaused(true)}
      onResume={() => void setPaused(false)}
    />
  );
}
