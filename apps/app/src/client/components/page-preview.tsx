import { PAGES, type PageId } from "@asksite/site-schema";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { pageToShow } from "../lib/page-preview.ts";
import { Notice } from "./feedback.tsx";

/** One page to show: its html as it is (the editor's render), or the same-origin address to fetch it from (a stored version). */
export type PreviewPageSource = { page: PageId; html: string } | { page: PageId; url: string };

/**
 * Asks the preview to show a page (the editor sends one each time the owner focuses or changes a field, A16 UX-8): `n` makes
 * every ask a new one, so asking for the same page twice still works after the viewer chose another page by hand.
 */
export interface FollowPage {
  page: PageId;
  n: number;
}

/** What the status line says when the frame tried to leave the shown page. */
export const LINKS_OFF = "Links are turned off in the preview.";

/**
 * Below this column width the preview opens on "Phone width": the 1280 px desktop page scaled to fit a column this narrow is
 * drawn at under half its size (a 356 px phone column: about 0.28) and is unreadable. At or above it, the preview opens on "Desktop width".
 */
export const PHONE_DEFAULT_BELOW_PX = 640;

/** "Desktop width" draws the page at this layout width, scaled down to fit the column (never scaled up). */
const DESKTOP_LAYOUT_PX = 1280;

/** The preview frame's border, on each side (border-slate-400, 1 px). */
const FRAME_BORDER_PX = 1;

/** The visible height of the frame: 80% of the window. */
const FRAME_HEIGHT = "80vh";

type Load = { state: "loading" } | { state: "error" } | { state: "ready"; html: string };

/**
 * The one preview of a site's pages, shared by the owner's Publish page and the admin's review (and the editor): a
 * "Page" group of buttons (one per page, named by PAGES[page].label), a "Page width" group, and the page in a sandboxed
 * srcdoc frame. The buttons sit outside the frame. A stored page is fetched from its own address and shown as it is
 * (the bytes are never changed); the frame has no allow-scripts, allow-forms, allow-same-origin or allow-top-navigation.
 *
 * Links inside the frame: a link would navigate the frame (a srcdoc frame resolves "/services" against the app's own
 * address), and CSS cannot stop Enter on a focused link. So any `load` of the frame after its first is taken as a
 * navigation away: the frame is mounted again on the page that was shown, and the status line says links are off.
 * If the page on screen leaves `pages` (the owner hid About), the preview falls back to Home and says so.
 * `onShown` (optional; only the admin's review passes it) is called with a page when its document has loaded in the frame: the
 * first `load` of each document, which means it rendered there, not that anyone read it.
 */
export function PagePreview({ pages, frameTitle, follow = null, onShown }: { pages: readonly PreviewPageSource[]; frameTitle: string; follow?: FollowPage | null; onShown?: (page: PageId) => void }) {
  const [wanted, setWanted] = useState<PageId>(pages[0]?.page ?? "home");
  const [phone, setPhone] = useState(false);
  const [columnWidth, setColumnWidth] = useState(0);
  const column = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<{ text: string; n: number } | null>(null);
  const announce = (text: string) => setStatus((last) => ({ text, n: (last?.n ?? 0) + 1 }));

  // The column's width, always (the scale of "Desktop width" follows it), and, once at mount, the view the preview opens on. The layout
  // effect runs before the first paint, so there is no flash of the other view; the choice is never taken again, so a resize or a
  // rotation never flips what the viewer picked. A column that is not laid out yet (a hidden pane reads 0) opens on the phone.
  useLayoutEffect(() => {
    const element = column.current;
    if (element === null) return;
    setPhone(element.clientWidth < PHONE_DEFAULT_BELOW_PX);
    const measure = () => setColumnWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The page on screen left the site (the owner hid About): Home, and say so.
  const { page: shown, note } = pageToShow(pages, wanted);
  useEffect(() => {
    if (note !== null) {
      announce(note);
      setWanted(shown);
    }
  }, [note, shown]);

  // The owner moved to a field on another page: show that page and say so (never a silent switch). A page the site does not have yet (the
  // owner just brought it back, and the preview is still drawing it) is waited for until the next pages arrive; if it is still not there, the ask is dropped.
  const waiting = useRef<FollowPage | null>(null);
  const honour = (ask: FollowPage) => {
    if (ask.page !== shown) {
      setWanted(ask.page);
      announce(`Showing the ${PAGES[ask.page].label} page`);
    }
  };
  useEffect(() => {
    if (follow === null) return;
    if (pages.some((p) => p.page === follow.page)) honour(follow);
    else waiting.current = follow;
  }, [follow]);
  useEffect(() => {
    const ask = waiting.current;
    waiting.current = null;
    if (ask !== null && pages.some((p) => p.page === ask.page)) honour(ask);
  }, [pages]);

  const source = pages.find((p) => p.page === shown);
  const view: View = phone ? { kind: "phone" } : { kind: "desktop", scale: desktopScale(columnWidth) };
  return (
    <div ref={column}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Page">
          {pages.map((p) => (
            <button key={p.page} type="button" className="btn-small" aria-pressed={p.page === shown} onClick={() => setWanted(p.page)}>
              {PAGES[p.page].label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Page width">
          <button type="button" className="btn-small" aria-pressed={!phone} onClick={() => setPhone(false)}>
            Desktop width
          </button>
          <button type="button" className="btn-small" aria-pressed={phone} onClick={() => setPhone(true)}>
            Phone width
          </button>
        </div>
      </div>
      <div role="status" className="mt-2 min-h-6 text-sm text-slate-700">
        {status === null ? null : <span key={status.n}>{status.text}</span>}
      </div>
      {source === undefined ? null : <PageFrame key={source.page} source={source} view={view} frameTitle={frameTitle} onLeftPage={() => announce(LINKS_OFF)} onShown={() => onShown?.(source.page)} />}
    </div>
  );
}

/** How the frame is drawn: a 390 px phone, or the 1280 px desktop layout at `scale` (1 or less). */
type View = { kind: "phone" } | { kind: "desktop"; scale: number };

/** The scale that fits the 1280 px layout, and the frame's border, into the column; 1 until the column is measured, never above 1. */
function desktopScale(columnWidth: number): number {
  return columnWidth <= 0 ? 1 : Math.min(1, (columnWidth - 2 * FRAME_BORDER_PX) / DESKTOP_LAYOUT_PX);
}

/** The frame box (its border and its visible size) and the iframe inside it, for a view. Inline styles: the numbers are computed, and the clipping must hold with no stylesheet. */
function frameStyles(view: View): { box: CSSProperties; frame: CSSProperties; boxClass: string } {
  if (view.kind === "phone") return { boxClass: "w-[390px] max-w-full", box: { height: FRAME_HEIGHT, overflow: "hidden" }, frame: { width: "100%", height: "100%" } };
  // The page lays out at 1280 x (visible height / scale) and is drawn at `scale` from the top left; the box is exactly the drawn size, so
  // nothing is clipped and nothing scrolls twice. A CSS transform keeps hit-testing and focus working (the browser maps them back).
  const { scale } = view;
  return {
    boxClass: "mx-auto",
    box: { width: DESKTOP_LAYOUT_PX * scale + 2 * FRAME_BORDER_PX, height: FRAME_HEIGHT, overflow: "hidden" },
    frame: { width: DESKTOP_LAYOUT_PX, height: `calc((${FRAME_HEIGHT} - ${2 * FRAME_BORDER_PX}px) / ${scale})`, transform: `scale(${scale})`, transformOrigin: "top left" },
  };
}

/**
 * One page in its frame: it fetches a stored page (or takes the html it was given) and hands the document to `LoadedFrame`.
 */
function PageFrame({ source, view, frameTitle, onLeftPage, onShown }: { source: PreviewPageSource; view: View; frameTitle: string; onLeftPage: () => void; onShown: () => void }) {
  const [load, setLoad] = useState<Load>("html" in source ? { state: "ready", html: source.html } : { state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const url = "url" in source ? source.url : null;
  const html = "html" in source ? source.html : null;

  useEffect(() => {
    if (html !== null) {
      setLoad({ state: "ready", html });
      return;
    }
    if (url === null) return;
    let live = true;
    setLoad({ state: "loading" });
    fetch(url, { credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) throw new Error("page request failed");
        return res.text();
      })
      .then(
        (text) => live && setLoad({ state: "ready", html: text }),
        () => live && setLoad({ state: "error" }),
      );
    return () => {
      live = false;
    };
  }, [url, html, attempt]);

  // The placeholder is as tall as the frame, so the buttons around it do not jump when the page arrives.
  if (load.state === "loading") {
    return (
      <p role="status" className={`mt-3 ${frameStyles(view).boxClass}`} style={frameStyles(view).box}>
        Loading the page…
      </p>
    );
  }
  if (load.state === "error") {
    return (
      <div role="alert">
        <Notice tone="error">The page couldn't load.</Notice>
        <button type="button" className="btn-secondary mt-3" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }
  return <LoadedFrame html={load.html} view={view} frameTitle={frameTitle} onLeftPage={onLeftPage} onShown={onShown} />;
}

/**
 * One document in an iframe. Any `load` after the first of that document is the frame leaving the page: it is mounted again
 * and the parent says so. Giving the inserted iframe a NEW srcdoc fires `load` too, but that is the new document arriving, so
 * the count starts again whenever `html` changes (a layout effect runs in the commit itself, so before that load can arrive).
 * The first `load` of a document also says the page was shown (`onShown`): it means the document rendered in the frame, not that anyone read it.
 */
function LoadedFrame({ html, view, frameTitle, onLeftPage, onShown }: { html: string; view: View; frameTitle: string; onLeftPage: () => void; onShown: () => void }) {
  const [mount, setMount] = useState(0);
  const loads = useRef(0);
  useLayoutEffect(() => {
    loads.current = 0;
  }, [html]);
  const styles = frameStyles(view);
  return (
    <div className={`mt-3 rounded-lg border border-slate-400 bg-white ${styles.boxClass}`} style={styles.box}>
      <iframe
        key={mount}
        title={frameTitle}
        sandbox=""
        srcDoc={html}
        className="block border-0"
        style={styles.frame}
        onLoad={() => {
          loads.current += 1;
          if (loads.current === 1) onShown();
          if (loads.current > 1) {
            loads.current = 0;
            setMount((n) => n + 1);
            onLeftPage();
          }
        }}
      />
    </div>
  );
}
