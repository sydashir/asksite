import type { PageId } from "@asksite/site-schema";
import type { RenderedSitePage } from "@asksite/renderer";
import { useEffect, useMemo, useRef } from "react";
import { Notice } from "../components/feedback.tsx";
import { PagePreview, type FollowPage } from "../components/page-preview.tsx";
import { focusSoon } from "../steps/types.ts";
import { previewFailureText, type SheetsState } from "../lib/preview-sheets.ts";

/** The id of the "Preview" heading in the editor: where focus goes when the preview appears after "Try again". */
export const PREVIEW_HEADING_ID = "editor-preview-heading";

interface Props {
  /** Whether the editor really is saved right now (never a hope): only then does the failure notice say so. */
  saved: boolean;
  sheets: SheetsState;
  /** The pages of the last valid draft, or null while there is none (or the sheets are not here). */
  pages: readonly RenderedSitePage[] | null;
  follow: FollowPage | null;
  afterReload: boolean;
  onRetry: () => void;
  onReload: () => void;
}

/**
 * The editor's live preview: the shared page preview over the last valid draft. While the stylesheets load it says so; if they
 * fail, it says that plainly, offers "Try again" and "Reload the page", and the editing beside it carries on and keeps saving (it says the changes are saved only while the editor is saved).
 */
export function PreviewPane({ saved, sheets, pages, follow, afterReload, onRetry, onReload }: Props) {
  const sources = useMemo(() => pages?.map(({ page, html }: { page: PageId; html: string }) => ({ page, html })) ?? null, [pages]);
  const retried = useRef(false);
  const ready = sheets.status === "ready";
  useEffect(() => {
    // "Try again" took keyboard focus with it when the notice went; on success, focus goes to the preview's heading.
    if (ready && retried.current) {
      retried.current = false;
      focusSoon(PREVIEW_HEADING_ID);
    }
  }, [ready]);
  // After "Try again" the notice stays (it is the same block while the sheets load again), so the pressed button keeps focus.
  const retrying = sheets.status === "loading" && sheets.failures > 0;
  if (sheets.status === "failed" || retrying) {
    return (
      <div role="alert">
        <Notice tone="warning">{retrying ? "Loading the preview…" : previewFailureText(sheets.failures, afterReload, saved)}</Notice>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary"
            aria-disabled={retrying}
            onClick={() => {
              if (retrying) return;
              retried.current = true;
              onRetry();
            }}
          >
            Try again
          </button>
          <button type="button" className="btn-secondary" onClick={onReload}>
            Reload the page
          </button>
        </div>
      </div>
    );
  }
  if (sources === null) {
    return <p role="status">{sheets.status === "loading" ? "Loading the preview…" : "The preview appears as soon as the issues above are fixed."}</p>;
  }
  return <PagePreview pages={sources} frameTitle="Preview of your website" follow={follow} />;
}
