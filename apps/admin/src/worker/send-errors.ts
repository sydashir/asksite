import { ApiError } from "@asksite/app-common";

const SEND_FAILED = "Email could not be sent, try again";
const EMAIL_SERVICE_LIMITED =
  "The email service is limiting how many emails we can send right now. Try again in a minute. If it still fails, today's email limit may be used up: try again after 00:00 UTC.";

/**
 * The admin's answer when an email it must send fails (502 email_failed). rate_limited gets its own words, true for
 * every Resend 429 the mailer maps to it (§7.6): the per-second limit (a minute later works) and the daily or
 * monthly quota (it does not). `failure` is what sendReporting returned.
 */
export function emailFailed(failure: string): ApiError {
  return new ApiError("email_failed", failure === "rate_limited" ? EMAIL_SERVICE_LIMITED : SEND_FAILED);
}
