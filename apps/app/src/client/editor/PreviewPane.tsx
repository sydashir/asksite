import type { PageId } from "@asksite/site-schema";
import type { RenderedSitePage } from "@asksite/renderer";
import { useMemo } from "react";
import { Notice } from "../components/feedback.tsx";
import { PagePreview, type FollowPage } from "../components/page-preview.tsx";
import { previewFailureText, type SheetsState } from "../lib/preview-sheets.ts";

interface Props {
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
 * fail, it says that plainly, offers "Try again" and "Reload the page", and the editing beside it carries on and keeps saving.
 */
export function PreviewPane({ sheets, pages, follow, afterReload, onRetry, onReload }: Props) {
  const sources = useMemo(() => pages?.map(({ page, html }: { page: PageId; html: string }) => ({ page, html })) ?? null, [pages]);
  if (sheets.status === "failed") {
    return (
      <div role="alert">
        <Notice tone="warning">{previewFailureText(sheets.failures, afterReload)}</Notice>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" onClick={onRetry}>
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
