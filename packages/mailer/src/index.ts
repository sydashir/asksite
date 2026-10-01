import { LogMailer } from "./log.ts";
import { ResendMailer } from "./resend.ts";
import { MailerError, type Mailer } from "./types.ts";

export { LogMailer } from "./log.ts";
export { ResendMailer } from "./resend.ts";
export { MailerError, type EmailTag, type Mailer, type MailerErrorCode, type OutgoingEmail } from "./types.ts";

/** Picks the mailer from configuration. A missing key or an unknown MAILER fails on send, as "misconfigured". */
export function createMailer(env: {
  MAILER: "resend" | "log";
  MAIL_FROM: string;
  RESEND_API_KEY?: string;
  DB: D1Database;
  ENVIRONMENT: string;
}): Mailer {
  const kind: string = env.MAILER;
  if (kind === "resend") return new ResendMailer(env.RESEND_API_KEY ?? "", env.MAIL_FROM);
  if (kind === "log") return new LogMailer(env.DB, env.ENVIRONMENT);
  return {
    send: () => Promise.reject(new MailerError("misconfigured", "MAILER must be resend or log")),
  };
}
