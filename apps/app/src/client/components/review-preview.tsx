import type { VersionSummary } from "@asksite/core";
import { PAGE_IDS, type PageId } from "@asksite/site-schema";
import { useEffect, useState } from "react";
import { Notice } from "./feedback.tsx";
import { PagePreview, type PreviewPageSource } from "./page-preview.tsx";

type Load = { state: "loading" } | { state: "error" } | { state: "ready"; pages: PreviewPageSource[] };

/** One stored page of the version: its html, null when the version has no such page (404), or a throw for any other answer. */
async function storedPage(siteId: string, versionId: string, page: PageId): Promise<PreviewPageSource | null> {
  const res = await fetch(`/api/sites/${siteId}/versions/${versionId}/pages/${page}`, { credentials: "same-origin" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("page request failed");
  return { page, html: await res.text() };
}

/**
 * What the owner sees of the version that was sent for review: every page it has, as stored, in the shared page preview.
 * The version's list of pages is not in the owner's site view, so each of the five page addresses is asked and the ones
 * the version lacks answer 404 (the per-page route lists only a version's own pages). Any other failure is an error, never a
 * page quietly left out.
 */
export function ReviewPreview({ siteId, version }: { siteId: string; version: VersionSummary }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    Promise.all(PAGE_IDS.map((page) => storedPage(siteId, version.id, page))).then(
      (found) => {
        const pages = found.filter((page): page is PreviewPageSource => page !== null);
        if (live) setLoad(pages[0]?.page === "home" ? { state: "ready", pages } : { state: "error" });
      },
      () => live && setLoad({ state: "error" }),
    );
    return () => {
      live = false;
    };
  }, [siteId, version.id, attempt]);

  return (
    <div className="mt-3">
      <h3 className="font-semibold">See what we are reviewing</h3>
      {load.state === "loading" ? (
        <p role="status" className="mt-2">
          Loading the pages…
        </p>
      ) : load.state === "error" ? (
        <div role="alert" className="mt-2">
          <Notice tone="error">The pages couldn't load.</Notice>
          <button type="button" className="btn-secondary mt-3" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : (
        <PagePreview pages={load.pages} frameTitle="Preview of the pages we are reviewing" />
      )}
    </div>
  );
}
