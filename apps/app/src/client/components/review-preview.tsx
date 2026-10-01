import type { VersionSummary } from "@asksite/core";

/**
 * How the owner sees the page that was sent for review. Today: the stored page in a new tab.
 * The one place the multi-page (A16) adapt replaces with the inline page preview.
 */
export function ReviewPreview({ siteId, version }: { siteId: string; version: VersionSummary }) {
  return (
    <p className="mt-2">
      <a className="link" href={`/api/sites/${siteId}/versions/${version.id}/page`} target="_blank" rel="noopener">
        See what we are reviewing (opens in a new tab)
      </a>
    </p>
  );
}
