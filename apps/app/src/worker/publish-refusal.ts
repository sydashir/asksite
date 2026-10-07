import { ApiError, MAX_ISSUES, secondsUntilUtcMidnight } from "@asksite/app-common";
import type { Issue } from "@asksite/core";

// Plan 2's refusals from createPendingVersion, as the owner API answers them (§4.4, decision 12).
// No Cloudflare types here, so the unit test runs in the plain Node test program.

const isIssue = (value: unknown): value is Issue => {
  const issue = value as Partial<Issue> | null;
  return typeof issue === "object" && issue !== null && Array.isArray(issue.path) && typeof issue.code === "string" && typeof issue.message === "string";
};

/** Plan 2 puts the seconds to wait in `detail.retryAfter`; the next UTC midnight if it is missing. */
function retryAfterOf(detail: unknown, now: number): number {
  const value = (detail as { retryAfter?: unknown } | undefined)?.retryAfter;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : secondsUntilUtcMidnight(now);
}

/** The answer to a publishing refusal the owner can act on, or null: the caller rethrows and the shared handler answers 500. */
export function publishRefusal(code: string, detail: unknown, now: number): ApiError | null {
  switch (code) {
    case "site_taken_down":
      return new ApiError("site_taken_down", "This website has been taken offline. Contact us to restore it.");
    case "publish_cap_reached":
      // Plan 2 decision 25: at most LIMITS.publishRequestsPerSitePerDay requests per site per UTC day.
      return new ApiError("rate_limited", "You have sent this website for review many times today. Try again tomorrow.", {
        retryAfter: retryAfterOf(detail, now),
      });
    case "integrity":
      // Plan 2 decision 10: the site changed between render and write (its address, say); nothing was stored.
      return (detail as { reason?: unknown } | undefined)?.reason === "site_changed"
        ? new ApiError("conflict", "Your website changed while it was being sent. Please send it again.")
        : null;
    case "render_failed": {
      // Only the first MAX_ISSUES (P4-3): Plan 2 lists one issue per schema problem, uncapped.
      const issues = Array.isArray(detail) ? detail.filter(isIssue).slice(0, MAX_ISSUES) : [];
      return new ApiError("publish_invalid", "A few things need fixing before this can be published", {
        issues: issues.length > 0 ? issues : [{ path: [], code: "render_failed", message: "The page could not be built" }],
      });
    }
    default:
      return null;
  }
}
