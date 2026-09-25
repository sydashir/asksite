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

/** Sends and reports success. A failure is logged by tag and error class only, never the address. */
export async function trySend(mailer: Mailer, email: OutgoingEmail): Promise<boolean> {
  try {
    await mailer.send(email);
    return true;
  } catch (err) {
    logLine({ event: "email_failed", tag: email.tag, error: err instanceof Error ? err.name : "unknown" });
    return false;
  }
}
