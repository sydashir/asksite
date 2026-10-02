export type PublishErrorCode =
  | "render_failed" | "nothing_pending" | "version_not_pending" | "integrity" | "not_live"
  | "site_taken_down" // detail.reason "taken_down_again" only from restore's expectedTakenDownAt check; approve, createPendingVersion, copyLivePagesAgain and restore's heal (a takedown that committed during the action) carry no detail
  | "publish_cap_reached" // Decision 25: Plan 4 answers 429 rate_limited with Retry-After = detail.retryAfter
  | "site_not_found" // Decision 28: Plan 4 answers 404 not_found
  | "live_copy_failed" // A16: the pointer write failed or is unconfirmed; the same action again finishes it (approve: Approve the same version again, or Copy the live pages again; restore of a taken-down site: Restore again, the site stays down until then; restore's heal of an already-restored site: the site is live in D1 but its pointer may be missing or old, and Restore again or Copy the live pages again heals it; copyLivePagesAgain: call it again)
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
