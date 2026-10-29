import type { AdminSiteRow, OrderListItem, SiteShopStatus } from "@asksite/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../../../app/src/client/components/dialog.tsx";
import { Select } from "../../../../app/src/client/components/fields.tsx";
import { Notice } from "../../../../app/src/client/components/feedback.tsx";
import { usePageHeading } from "../../../../app/src/client/hooks/use-page-heading.ts";
import { navigate, onLinkClick } from "../../../../app/src/client/hooks/use-route.ts";
import { api } from "../../../../app/src/client/lib/api.ts";
import { useResource } from "../hooks.ts";
import { rememberOrdersSearch } from "../orders/back.ts";
import { OrderList } from "../orders/OrderList.tsx";
import { SiteShopSection } from "../orders/SiteShopSection.tsx";
import { ALL_NOT_PAUSED_TEXT, ALL_PAUSED_TEXT, ALL_RESUMED_TEXT, emptyOrdersText, ordersPath, ordersRequest, readOrdersFilters, UNSURE, type OrdersFilters } from "../orders/words.ts";

type ListState = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; orders: OrderListItem[]; next: number | null };

/** The every-shop pause: shown as a state only when it is known (a chosen site's status, or the answer to the last switch). */
function AllOrdersSwitch({ allPaused, onChange }: { allPaused: boolean | null; onChange: (paused: boolean) => void }) {
  const [confirming, setConfirming] = useState<boolean | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-3">
      {allPaused !== null ? <p className="text-slate-700">{allPaused ? ALL_PAUSED_TEXT : ALL_NOT_PAUSED_TEXT}</p> : null}
      {allPaused !== true ? (
        <button type="button" className="btn-secondary" onClick={() => setConfirming(true)}>
          Pause all orders
        </button>
      ) : null}
      {allPaused !== false ? (
        <button type="button" className="btn-secondary" onClick={() => setConfirming(false)}>
          Turn off the every-shop pause
        </button>
      ) : null}
      <ConfirmDialog
        open={confirming !== null}
        title={confirming === true ? "Pause orders on every shop?" : "Turn off the every-shop pause?"}
        confirmLabel={confirming === true ? "Pause all orders" : "Turn it off"}
        danger={confirming === true}
        onConfirm={() => {
          const paused = confirming === true;
          setConfirming(null);
          onChange(paused);
        }}
        onCancel={() => setConfirming(null)}
      >
        <p>{confirming === true ? "Buyers on every shop see that ordering is paused." : "Shops paused on their own stay paused."}</p>
      </ConfirmDialog>
    </div>
  );
}

/** Every site's orders for staff (admin-orders-plan.md §3.1-3.2): filters in the address, a page at a time, newest first. */
export function Orders({ search }: { search: string }) {
  const heading = usePageHeading<HTMLHeadingElement>("Orders", "Admin");
  const filters = readOrdersFilters(search);
  const { siteId, spam } = filters;
  const sites = useResource<{ sites: AdminSiteRow[] }>("/api/admin/sites?filter=all");
  const [list, setList] = useState<ListState>({ state: "loading" });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [allPaused, setAllPaused] = useState<boolean | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  /** Where focus goes after "Try again": the list area (the button it came from is gone by then). */
  const resultsRef = useRef<HTMLDivElement>(null);
  const older = useRef(false);
  /** Bumped by every new load: an answer for an older tag (a filter changed, or a newer load started) is dropped, never shown. */
  const generation = useRef(0);
  /** Remounts the Shop card after the every-shop switch, so its "All shops" line reads the new state. */
  const [shopRefresh, setShopRefresh] = useState(0);

  useEffect(() => rememberOrdersSearch(ordersPath({ siteId, spam }).slice("/orders".length)), [siteId, spam]);

  /** Loads the first page; true when its answer was shown (false when a newer load took over). */
  const load = useCallback(async (): Promise<boolean> => {
    const tag = ++generation.current;
    older.current = false;
    setLoadingOlder(false);
    setList({ state: "loading" });
    setOlderError(null);
    setFocusId(null);
    const res = await api<{ orders: OrderListItem[]; nextBefore: number | null }>("GET", ordersRequest({ siteId, spam }, null));
    if (tag !== generation.current) return false;
    setList(res.ok ? { state: "ready", orders: res.data.orders, next: res.data.nextBefore } : { state: "error", message: res.error.message });
    return true;
  }, [siteId, spam]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadOlder() {
    if (list.state !== "ready" || list.next === null || older.current) return;
    const tag = generation.current;
    older.current = true;
    setLoadingOlder(true);
    setOlderError(null);
    const res = await api<{ orders: OrderListItem[]; nextBefore: number | null }>("GET", ordersRequest({ siteId, spam }, list.next));
    // A filter changed (or the list reloaded) while this page was on its way: it belongs to the old list, so it is dropped.
    if (tag !== generation.current) return;
    older.current = false;
    setLoadingOlder(false);
    if (!res.ok) {
      setOlderError(res.error.message);
      return;
    }
    const listed = new Set(list.orders.map((o) => o.id));
    const fresh = res.data.orders.filter((o) => !listed.has(o.id));
    setList((prev) => (prev.state === "ready" ? { state: "ready", orders: [...prev.orders, ...fresh], next: res.data.nextBefore } : prev));
    // The button goes with the last page: focus moves to the first new row instead of dropping to the page.
    if (res.data.nextBefore === null && fresh[0] !== undefined) setFocusId(fresh[0].id);
  }

  const setFilters = (next: OrdersFilters) => navigate(ordersPath(next));
  const onSiteStatus = useCallback((status: SiteShopStatus) => setAllPaused(status.allOrdersPaused), []);

  async function switchAll(paused: boolean) {
    const res = await api<{ allOrdersPaused: boolean }>("POST", `/api/admin/orders/${paused ? "pause-all" : "resume-all"}`, {});
    if (res.ok) {
      setAllPaused(res.data.allOrdersPaused);
      setShopRefresh((n) => n + 1);
      setMessage({ tone: "success", text: res.data.allOrdersPaused ? "Orders paused on every shop." : ALL_RESUMED_TEXT });
    } else if (res.status === 0 || res.status >= 500) {
      // The switch may or may not have changed: the page stops claiming either state and re-reads the Shop card.
      setAllPaused(null);
      setShopRefresh((n) => n + 1);
      setMessage({ tone: "error", text: UNSURE });
    } else setMessage({ tone: "error", text: res.error.message });
    requestAnimationFrame(() => messageRef.current?.focus());
  }

  const siteOptions = sites.load.state === "ready" ? sites.load.data.sites.filter((s) => s.slug !== null).map((s) => ({ value: s.id, label: s.businessName === null ? s.slug! : `${s.businessName} (${s.slug})` })) : [];
  const chosen = sites.load.state === "ready" ? sites.load.data.sites.find((s) => s.id === siteId) : undefined;

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 ref={heading} tabIndex={-1} className="page-title">
          Orders
        </h1>
        <AllOrdersSwitch allPaused={allPaused} onChange={(paused) => void switchAll(paused)} />
      </div>
      <div ref={messageRef} role="status" tabIndex={-1}>
        {message !== null ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      </div>

      <div className="mt-2 flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="w-full max-w-sm">
          <Select
            id="orders-site"
            label="Site"
            emptyLabel="All sites"
            options={siteOptions}
            value={siteId ?? ""}
            onChange={(value) => setFilters({ siteId: value === "" ? null : value, spam })}
          />
        </div>
        <div role="group" aria-label="Show" className="flex gap-2">
          <button type="button" className="btn-small" aria-pressed={!spam} onClick={() => setFilters({ siteId, spam: false })}>
            Orders
          </button>
          <button type="button" className="btn-small" aria-pressed={spam} onClick={() => setFilters({ siteId, spam: true })}>
            Spam
          </button>
        </div>
      </div>
      {sites.load.state === "error" ? <Notice tone="warning">The site list could not load, so the Site filter is empty. {sites.load.error.message}</Notice> : null}

      {siteId !== null ? (
        <div className="mt-6">
          <SiteShopSection key={`${siteId}-${shopRefresh}`} siteId={siteId} siteName={chosen?.slug ?? chosen?.businessName ?? "this site"} live={chosen === undefined ? null : chosen.live && !chosen.takenDown} showOrdersLink={false} onStatus={onSiteStatus} />
        </div>
      ) : null}

      <div ref={resultsRef} tabIndex={-1}>
        {list.state === "loading" ? (
          <p role="status" className="loading mt-6">
            <span className="spinner" aria-hidden="true" />
            Loading orders…
          </p>
        ) : null}
        {list.state === "error" ? (
          <div role="alert">
            <Notice tone="error">
              We couldn't load the orders. {list.message}
              <button
                type="button"
                className="btn-secondary mt-3 flex"
                onClick={() => void load().then((shown) => (shown ? requestAnimationFrame(() => resultsRef.current?.focus()) : undefined))}
              >
                Try again
              </button>
            </Notice>
          </div>
        ) : null}
        {list.state === "ready" ? (
          <OrderList
            orders={list.orders}
            emptyText={emptyOrdersText(filters)}
            hrefFor={(id) => `/orders/${id}`}
            onOpen={onLinkClick}
            hasMore={list.next !== null}
            loadingOlder={loadingOlder}
            olderError={olderError}
            onLoadOlder={() => void loadOlder()}
            focusId={focusId}
          />
        ) : null}
      </div>
    </section>
  );
}
