import { logLine } from "./http.ts";

// The @asksite/mailer contract (design §7.6, Plan 2), restated here so Plan 4 can be built and
// tested before Plan 2 lands. The integration task checks the real package against it.
export type EmailTag = "lead" | "magic_link" | "invite" | "review_result" | "site_notice" | "admin_alert";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  tag: EmailTag;
  idempotencyKey: string;
}

export interface Mailer {
  send(email: OutgoingEmail): Promise<{ id: string }>;
}

/** The codes of Plan 2's MailerError (design §7.6), read structurally: @asksite/mailer is not imported here. */
const MAILER_ERROR_CODES: readonly string[] = ["rate_limited", "rejected", "unavailable", "misconfigured"];

/** What a failure log may say: the mailer's code, else the error's class name, else "unknown". Never its message. */
function failureOf(err: unknown): string {
  const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
  if (typeof code === "string" && MAILER_ERROR_CODES.includes(code)) return code;
  return err instanceof Error ? err.name : "unknown";
}

/** Sends and reports success. A failure is logged by tag and error code or class only, never the address. */
export async function trySend(mailer: Mailer, email: OutgoingEmail): Promise<boolean> {
  try {
    await mailer.send(email);
    return true;
  } catch (err) {
    logLine({ event: "email_failed", tag: email.tag, error: failureOf(err) });
    return false;
  }
}
