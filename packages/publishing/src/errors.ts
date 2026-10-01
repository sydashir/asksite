export type PublishErrorCode =
  | "render_failed" | "nothing_pending" | "version_not_pending" | "site_taken_down" | "integrity" | "not_live"
  | "publish_cap_reached" // Decision 25: Plan 4 answers 429 rate_limited with Retry-After = detail.retryAfter
  | "site_not_found" // Decision 28: Plan 4 answers 404 not_found
  | "live_copy_failed"; // A16: the approval is recorded but the pointer write failed; approving the same version again finishes it

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
