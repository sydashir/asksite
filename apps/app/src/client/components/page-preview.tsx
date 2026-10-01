import { PAGES, type PageId } from "@asksite/site-schema";
import { useEffect, useRef, useState } from "react";
import { pageToShow } from "../lib/page-preview.ts";
import { Notice } from "./feedback.tsx";

/** One page to show: its html as it is (the editor's render), or the same-origin address to fetch it from (a stored version). */
export type PreviewPageSource = { page: PageId; html: string } | { page: PageId; url: string };

/** What the status line says when the frame tried to leave the shown page. */
export const LINKS_OFF = "Links are turned off in the preview.";

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
 */
export function PagePreview({ pages, frameTitle }: { pages: readonly PreviewPageSource[]; frameTitle: string }) {
  const [wanted, setWanted] = useState<PageId>(pages[0]?.page ?? "home");
  const [phone, setPhone] = useState(false);
  const [status, setStatus] = useState<{ text: string; n: number } | null>(null);
  const announce = (text: string) => setStatus((last) => ({ text, n: (last?.n ?? 0) + 1 }));

  // The page on screen left the site (the owner hid About): Home, and say so.
  const { page: shown, note } = pageToShow(pages, wanted);
  useEffect(() => {
    if (note !== null) {
      announce(note);
      setWanted(shown);
    }
  }, [note, shown]);

  const source = pages.find((p) => p.page === shown);
  const size = phone ? "h-[80vh] w-[390px] max-w-full" : "h-[80vh] w-full";
  return (
    <div>
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
      {source === undefined ? null : <PageFrame key={source.page} source={source} size={size} frameTitle={frameTitle} onLeftPage={() => announce(LINKS_OFF)} />}
    </div>
  );
}

/**
 * One page in its frame: it fetches a stored page (or takes the html it was given) and hands the document to `LoadedFrame`.
 */
function PageFrame({ source, size, frameTitle, onLeftPage }: { source: PreviewPageSource; size: string; frameTitle: string; onLeftPage: () => void }) {
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
      <p role="status" className={`mt-3 ${size}`}>
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
  return <LoadedFrame html={load.html} size={size} frameTitle={frameTitle} onLeftPage={onLeftPage} />;
}

/**
 * One document in an iframe. Any `load` after the first of that document is the frame leaving the page: it is mounted again
 * and the parent says so. Giving the inserted iframe a NEW srcdoc fires `load` too, but that is the new document arriving, so
 * the count starts again whenever `html` changes (the effect runs before that load can arrive).
 */
function LoadedFrame({ html, size, frameTitle, onLeftPage }: { html: string; size: string; frameTitle: string; onLeftPage: () => void }) {
  const [mount, setMount] = useState(0);
  const loads = useRef(0);
  useEffect(() => {
    loads.current = 0;
  }, [html]);
  return (
    <iframe
      key={mount}
      title={frameTitle}
      sandbox=""
      srcDoc={html}
      className={`mt-3 rounded-lg border border-slate-400 bg-white ${size}`}
      onLoad={() => {
        loads.current += 1;
        if (loads.current > 1) {
          loads.current = 0;
          setMount((n) => n + 1);
          onLeftPage();
        }
      }}
    />
  );
}
