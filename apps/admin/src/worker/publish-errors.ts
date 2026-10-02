import { ApiError } from "@asksite/app-common";
import { APPROVE_LIVE_COPY_FAILED, COPY_LIVE_COPY_FAILED, LEASE_LOST, RESTORE_LIVE_COPY_FAILED, SITE_BUSY, TAKEN_DOWN_AGAIN } from "../messages.ts";

/** Plan 2's codes: design §7.2 plus `publish_cap_reached` (its decision 25), `site_not_found` (decision 28), `live_copy_failed` (A16) and `site_busy` (A16-4c). */
export type PublishErrorCode =
  | "render_failed"
  | "nothing_pending"
  | "version_not_pending"
  | "site_taken_down"
  | "integrity"
  | "not_live"
  | "publish_cap_reached"
  | "site_not_found"
  | "live_copy_failed"
  | "site_busy";

/** Which admin action failed: the wording of several failures depends on it. */
export type PublishAction = "review" | "restore" | "copy" | "change";

const detailField = (detail: unknown, name: string): unknown => (typeof detail === "object" && detail !== null ? (detail as Record<string, unknown>)[name] : undefined);

/**
 * The admin API's answer to a publishing failure (design §4.5). `site_not_found` is Plan 2's
 * decision 28 (answered 404). null: not a failure the admin can act on, so the caller rethrows it
 * and the shared handler answers 500 without details.
 */
export function publishApiError(code: PublishErrorCode, action: PublishAction, detail?: unknown): ApiError | null {
  switch (code) {
    case "site_not_found":
      return new ApiError("not_found", "Not found");
    case "version_not_pending":
      return new ApiError("version_not_pending", "This version is no longer waiting for review");
    case "site_taken_down":
      if (action === "copy") return new ApiError("conflict", "This site is taken down, so there is nothing to copy. Reload to see where it stands now.");
      return new ApiError("site_taken_down", action === "restore" && detailField(detail, "reason") === "taken_down_again" ? TAKEN_DOWN_AGAIN : "This site is taken down");
    case "not_live":
      return new ApiError("conflict", action === "copy" ? "This site is not live, so there is nothing to copy" : "This site was never live, so there is nothing to restore");
    case "integrity":
      if (action === "copy") return new ApiError("internal", "The stored pages don't match what was approved, so nothing was copied.");
      return new ApiError(
        "internal",
        action === "restore" ? "The stored page does not match its record. It was not restored." : "The stored page does not match what was reviewed. Reload and review it again.",
      );
    case "live_copy_failed":
      if (action === "restore") return new ApiError("internal", RESTORE_LIVE_COPY_FAILED);
      if (action === "copy") return new ApiError("internal", COPY_LIVE_COPY_FAILED);
      return new ApiError("internal", APPROVE_LIVE_COPY_FAILED);
    case "site_busy": {
      // lease_lost has no retryAfter and answers no Retry-After header: waiting would not help, a reload shows where the site stands.
      if (detailField(detail, "reason") === "lease_lost") return new ApiError("conflict", LEASE_LOST);
      const retryAfter = detailField(detail, "retryAfter");
      return new ApiError("conflict", SITE_BUSY, typeof retryAfter === "number" && Number.isInteger(retryAfter) && retryAfter > 0 ? { retryAfter } : {});
    }
    default:
      return null;
  }
}
