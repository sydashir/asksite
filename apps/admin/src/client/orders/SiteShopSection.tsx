import type { SiteShopStatus } from "@asksite/core";
import { useEffect, useRef, useState } from "react";
import { Notice } from "../../../../app/src/client/components/feedback.tsx";
import { onLinkClick } from "../../../../app/src/client/hooks/use-route.ts";
import { api } from "../../../../app/src/client/lib/api.ts";
import { useResource } from "../hooks.ts";
import { ShopStatusCard } from "./ShopStatusCard.tsx";
import { orderBlocker, ordersPath, resumedText, SHOP_CHANGED_ELSEWHERE, UNSURE } from "./words.ts";

/** The last action's result, worded once from the status read back right after it, so it never rewrites itself later. */
type Result = { tone: "success" | "warning" | "error"; text: string };

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
  /** Wraps whatever the section shows, so focus has a place to land after "Try again" (the button it came from may be gone). */
  const areaRef = useRef<HTMLDivElement>(null);
  const [retrying, setRetrying] = useState(false);
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
      const fresh = await reload();
      if (res.ok && paused) setResult({ tone: "success", text: "Orders paused for this site." });
      else if (res.ok) {
        const can = fresh !== null && orderBlocker(fresh, props.live) === null;
        setResult({ tone: can ? "success" : "warning", text: fresh === null ? "This site's own pause is off." : resumedText(fresh, props.live) });
      } else if (res.status === 409) setResult({ tone: "error", text: SHOP_CHANGED_ELSEWHERE });
      else if (res.status === 0 || res.status >= 500) setResult({ tone: "error", text: UNSURE });
      else setResult({ tone: "error", text: res.error.message });
      requestAnimationFrame(() => messageRef.current?.focus());
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    await reload();
    setRetrying(false);
    requestAnimationFrame(() => areaRef.current?.focus());
  }

  return (
    <div ref={areaRef} tabIndex={-1}>
      {load.state === "loading" ? (
        <p role="status" className="loading mt-4">
          <span className="spinner" aria-hidden="true" />
          Loading the shop…
        </p>
      ) : null}
      {load.state === "error" ? (
        <div role="alert">
          <Notice tone="error">
            We couldn't load the shop. {load.error.message}
            <button type="button" className="btn-secondary mt-3 flex" aria-disabled={retrying} onClick={() => void retry()}>
              {retrying ? "Trying again…" : "Try again"}
            </button>
          </Notice>
        </div>
      ) : null}
      {load.state === "ready" ? (
        <ShopStatusCard
          status={load.data}
          live={props.live}
          siteName={props.siteName}
          ordersHref={props.showOrdersLink ? ordersPath({ siteId: props.siteId, spam: false }) : null}
          onLink={onLinkClick}
          busy={busy}
          message={result === null ? null : <Notice tone={result.tone}>{result.text}</Notice>}
          messageRef={messageRef}
          onPause={() => void setPaused(true)}
          onResume={() => void setPaused(false)}
        />
      ) : null}
    </div>
  );
}
