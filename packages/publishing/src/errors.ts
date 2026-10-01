export type PublishErrorCode =
  | "render_failed" | "nothing_pending" | "version_not_pending" | "site_taken_down" | "integrity" | "not_live"
  | "publish_cap_reached" // Decision 25: Plan 4 answers 429 rate_limited with Retry-After = detail.retryAfter
  | "site_not_found" // Decision 28: Plan 4 answers 404 not_found
  | "live_copy_failed" // A16: the pointer write failed or is unconfirmed; approving the same version again, or Copy the live pages again, finishes it
  | "site_busy"; // A16-4c: another admin action on this site is still running, or this one's lease expired; Plan 4 answers 409 with Retry-After = detail.retryAfter when present

// An explicit field instead of a constructor parameter property (the repo's tsconfig sets
// erasableSyntaxOnly). Public shape as in the design: readonly code, readonly detail.
export class PublishError extends Error {
  readonly code: PublishErrorCode;
  readonly detail?: unknown;

  constructor(code: PublishErrorCode, detail?: unknown) {
    super(code);
    this.name = "PublishError";
    this.code = code;
    this.detail = detail;
  }
}
