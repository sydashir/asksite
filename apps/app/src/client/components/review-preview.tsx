import type { OwnerVersionSummary } from "@asksite/core";
import type { PageId } from "@asksite/site-schema";
import { useEffect, useState } from "react";
import { Notice } from "./feedback.tsx";
import { PagePreview, type PreviewPageSource } from "./page-preview.tsx";

type Load = { state: "loading" } | { state: "error" } | { state: "ready"; pages: PreviewPageSource[] };

/** One stored page of the version: its html, or a throw for any answer but 200 (the version lists this page, so it must be there). */
async function storedPage(siteId: string, versionId: string, page: PageId): Promise<PreviewPageSource> {
  const res = await fetch(`/api/sites/${siteId}/versions/${versionId}/pages/${page}`, { credentials: "same-origin" });
  if (!res.ok) throw new Error("page request failed");
  return { page, html: await res.text() };
}

/**
 * What the owner sees of the version that was sent for review: every page it has, as stored, in the shared page preview.
 * Only the pages the version lists (its `pages`, in page order) are asked for. Any failure, or a version that lists no
 * page (a row from before A16), is an error, never a page quietly left out.
 */
export function ReviewPreview({ siteId, version }: { siteId: string; version: OwnerVersionSummary }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  // A new site view brings a new array each time; the preview is loaded again only when the pages themselves change.
  const pageList = version.pages.join(",");
  useEffect(() => {
    let live = true;
    setLoad({ state: "loading" });
    Promise.all(version.pages.map((page) => storedPage(siteId, version.id, page))).then(
      (pages) => live && setLoad(pages[0]?.page === "home" ? { state: "ready", pages } : { state: "error" }),
      () => live && setLoad({ state: "error" }),
    );
    return () => {
      live = false;
    };
  }, [siteId, version.id, pageList, attempt]);

  return (
    <div className="mt-5">
      <h3 className="mb-3 font-semibold text-ink">See what we are reviewing</h3>
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
