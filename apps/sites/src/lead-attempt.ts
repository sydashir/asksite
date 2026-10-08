import { MailerError } from "@asksite/mailer";

// Which idempotency key a lead email's attempt uses (C1 RULING 3, 2026-10-08). The form's first send uses
// `lead:<id>`. After Resend answered 429 or 5xx the email was not sent, and Resend may keep that answer under the key
// for 24 hours (its docs do not say), so the next attempt takes the next key, `lead:<id>:<n>`. With no answer (not
// reached, timed out), an answer without an email id, or a 409 for a request still in progress, the email may have
// gone out, so the next attempt keeps the key and Resend's replay keeps it to one email ("the same response, without
// actually sending the email again", resend.com/docs/dashboard/emails/idempotency-keys).
// The key's number travels in the lead row, no schema change: email_error '<code>:<n>' after a failed attempt and
// 'retrying:<ms>:<n>' while a retry run holds the lead; no ':<n>' means 1.

/** The idempotency key of attempt key number `n`: the form's own `lead:<id>` for 1. */
export function leadKey(leadId: string, n: number): string {
  return n === 1 ? `lead:${leadId}` : `lead:${leadId}:${n}`;
}

/** The key number a stored email_error or claim names: the last ':<n>' after '<code>' or 'retrying:<ms>', else 1. */
export function keyNumberOf(stored: string | null): number {
  const parts = (stored ?? "").split(":");
  if (parts.length < (parts[0] === "retrying" ? 3 : 2)) return 1;
  const n = Number(parts.at(-1));
  return Number.isSafeInteger(n) && n >= 1 ? n : 1;
}

const withKey = (code: string, n: number): string => (n === 1 ? code : `${code}:${n}`);

/**
 * What a failed attempt with key number `n` stores in email_error: '<code>:<n + 1>' after a 429 or 5xx (not sent: next
 * key), 'unavailable' with the same number when the email may have gone out, else a final code that is never retried
 * ('rejected', also for a 409 whose body changed under the key; 'misconfigured'; 'internal').
 */
export function failedAttempt(e: unknown, n: number): string {
  if (!(e instanceof MailerError)) return "internal";
  if (e.status === 429 || (e.status !== undefined && e.status >= 500)) return `${e.code}:${n + 1}`;
  if (e.status === 409 && e.reason === "concurrent_idempotent_requests") return withKey("unavailable", n);
  if (e.code === "unavailable") return withKey("unavailable", n);
  return e.code;
}
