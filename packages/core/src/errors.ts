import type { Issue } from "./issues.ts";

/** Every API error code and its HTTP status. */
export const ERROR_STATUS = {
  bad_request: 400, unauthenticated: 401, forbidden: 403, owner_disabled: 403, not_found: 404,
  conflict: 409, slug_taken: 409, slug_locked: 409, generation_in_progress: 409,
  nothing_pending: 409, version_not_pending: 409, wording_changed: 409,
  invite_invalid: 410, token_invalid: 410,
  payload_too_large: 413, unsupported_media_type: 415,
  validation_failed: 422, not_ready: 422, publish_invalid: 422, slug_invalid: 422, image_rejected: 422,
  site_taken_down: 423,
  rate_limited: 429, generation_cap_reached: 429, upload_limit_reached: 429,
  internal: 500, email_failed: 502, generation_disabled: 503, budget_exhausted: 503,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;
export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    issues?: Issue[];
    retryAfter?: number;
    currentRev?: number;
    /** The takedown route's lease_lost 409 only: true (this call took the site down and the owner notice went out), false (it failed), null (this call sent none). */
    noticeSent?: boolean | null;
    /** The takedown route's lease_lost 409 only, with `noticeSent: null`: the re-read of the takedown failed, so it is UNKNOWN whether this call took the site down (and so whether the owner was owed a notice). Absent otherwise. */
    noticeUnknown?: true;
  };
}
