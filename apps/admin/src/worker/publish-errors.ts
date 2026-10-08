import { ApiError } from "@asksite/app-common";
import { APPROVE_LEASE_LOST, APPROVE_LIVE_COPY_FAILED, COPY_LIVE_COPY_FAILED, DELETE_LEASE_LOST, LEASE_LOST, OWNER_SITE_BUSY, RESTORE_LIVE_COPY_FAILED, SITE_BUSY, TAKEDOWN_LEASE_LOST, TAKEN_DOWN_AGAIN } from "../messages.ts";

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

/** Which admin action failed: the wording of several failures depends on it ("review" is Reject; Approve and the takedown have their own). */
export type PublishAction = "review" | "approve" | "restore" | "copy" | "change" | "takedown" | "delete_owner";

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
      return new ApiError("conflict", action === "copy" ? "This site is not live, so there is nothing to copy." : "This site was never live, so there is nothing to restore");
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
      // The wording depends on what may already have happened: an approval or a takedown may have committed before the lease ran out.
      if (detailField(detail, "reason") === "lease_lost") {
        return new ApiError("conflict", action === "approve" ? APPROVE_LEASE_LOST : action === "takedown" ? TAKEDOWN_LEASE_LOST : action === "delete_owner" ? DELETE_LEASE_LOST : LEASE_LOST);
      }
      const retryAfter = detailField(detail, "retryAfter");
      // Delete the account takes the lease of every site of the owner: a held one is named for the owner ("Nothing was deleted").
      return new ApiError("conflict", action === "delete_owner" ? OWNER_SITE_BUSY : SITE_BUSY, typeof retryAfter === "number" && Number.isInteger(retryAfter) && retryAfter > 0 ? { retryAfter } : {});
    }
    default:
      return null;
  }
}
