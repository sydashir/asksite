import { ApiError } from "@asksite/app-common";

/** Plan 2's codes: design §7.2 plus `publish_cap_reached` (its decision 25), `site_not_found` (decision 28) and `live_copy_failed` (A16). */
export type PublishErrorCode =
  | "render_failed"
  | "nothing_pending"
  | "version_not_pending"
  | "site_taken_down"
  | "integrity"
  | "not_live"
  | "publish_cap_reached"
  | "site_not_found"
  | "live_copy_failed";

/** Which admin action failed: the wording of an integrity failure depends on it. */
export type PublishAction = "review" | "restore" | "change";

/**
 * The admin API's answer to a publishing failure (design §4.5). `site_not_found` is Plan 2's
 * decision 28 (answered 404). null: not a failure the admin can act on, so the caller rethrows it
 * and the shared handler answers 500 without details.
 */
export function publishApiError(code: PublishErrorCode, action: PublishAction): ApiError | null {
  switch (code) {
    case "site_not_found":
      return new ApiError("not_found", "Not found");
    case "version_not_pending":
      return new ApiError("version_not_pending", "This version is no longer waiting for review");
    case "site_taken_down":
      return new ApiError("site_taken_down", "This site is taken down");
    case "not_live":
      return new ApiError("conflict", "This site was never live, so there is nothing to restore");
    case "integrity":
      return new ApiError(
        "internal",
        action === "restore" ? "The stored page does not match its record. It was not restored." : "The stored page does not match what was reviewed. Reload and review it again.",
      );
    case "live_copy_failed":
      return new ApiError("internal", "Approved, but the new pages are not live yet. Press Approve again.");
    default:
      return null;
  }
}
