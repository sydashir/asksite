/**
 * The codes of Plan 2's MailerError (design §7.6), read structurally as @asksite/app-common's trySend
 * reads them (its classifier is not exported): the admin notes them on the request's own log line.
 */
const MAILER_ERROR_CODES: readonly string[] = ["rate_limited", "rejected", "unavailable", "misconfigured"];

/** What a failed send may log: the mailer's code, else the error's class name, else "unknown". Never its message. */
export function mailFailure(err: unknown): string {
  const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
  if (typeof code === "string" && MAILER_ERROR_CODES.includes(code)) return code;
  return err instanceof Error ? err.name : "unknown";
}
