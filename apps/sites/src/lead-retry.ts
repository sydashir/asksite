import { siteUrl } from "@asksite/core";
import { createMailer, MailerError } from "@asksite/mailer";
import type { Env } from "./env.ts";
import { leadEmail } from "./lead-email.ts";

// C1 (go-live blocker): the form emails a lead once, after the 303 (form.ts emailOwner). When Resend is down or
// over its quota that send fails, and this cron run (every 15 minutes, RETRY_CRON) sends it again.
//
// The same email, so never two: the key is the first send's `lead:<id>` and the body is rebuilt from the stored
// lead, byte-identical. Resend keeps a key for 24 hours and answers a repeat of the same key and body with "the same
// response, without actually sending the email again"; a different body gets 409 invalid_idempotent_request
// (resend.com/docs/dashboard/emails/idempotency-keys). Only leads of the last 23 h are read, inside those 24.
//
// Claimed before sent: a run first sets the lead to pending with email_error 'retrying:<its scheduled time>',
// guarded on the values it read, so of two runs that read the same lead only one sends it. RULING 2 (2026-10-08):
// the claim carries its time because the lead's own age says nothing about when it was claimed. A claim more than
// 20 minutes old belongs to a run that is over (a Cron Trigger runs at most 15 minutes,
// developers.cloudflare.com/workers/platform/limits/), and its lead is read again; a younger one is left to its run,
// which may still be sending (a second request with the key then would get Resend's 409
// concurrent_idempotent_requests). The result is written only over the run's own claim.

/** At most this many leads are emailed again per run. */
export const RETRY_PER_RUN = 10;
/** Only leads younger than this are read: Resend keeps an idempotency key for 24 hours. */
const RETRY_WINDOW_MS = 23 * 3_600_000;
/** A 'pending' lead with no error is retried after this: the form's send times out after 10 s, so it is over. */
const STALE_PENDING_MS = 10 * 60_000;
/** A claim older than this belongs to a run that is over (Cron Triggers stop at 15 minutes). */
const STALE_CLAIM_MS = 20 * 60_000;

/**
 * The leads to email again, oldest first: failed for an outage or a rate limit (`unavailable`, `rate_limited`; a
 * refusal, a broken setup, an unknown error or the daily cap would fail the same way again), pending with no error
 * (its first send died), or claimed by a run that is over. Never spam, never a lead older than 23 h.
 * `spam = 0 AND email_error IS NOT 'daily_cap'` are the partial index leads_emailed's own terms (migration 0007),
 * written out so SQLite can use it: the read covers the last 23 h of tried leads, not the table
 * (lead-index.workerd.test.ts). CROSS JOIN is SQLite's inner join kept in the written order, so leads, read through
 * the index, always come first and find each site and owner by id: with statistics from a one-site table, a plain JOIN
 * made workerd's SQLite scan sites and owners first and read leads by site (measured 2026-10-08). Foreign keys keep
 * every lead's site and owner. A taken-down site's or a
 * disabled owner's lead is still sent: it was accepted while the site was live, and the owner sees it in the app.
 */
export const RETRY_SQL = `SELECT l.id, l.name, l.phone, l.email, l.service, l.message, l.email_status, l.email_error, s.slug, o.email AS owner_email
FROM leads l CROSS JOIN sites s ON s.id = l.site_id CROSS JOIN owners o ON o.id = s.owner_id
WHERE l.created_at >= ?1 AND l.spam = 0 AND l.email_error IS NOT 'daily_cap' AND s.slug IS NOT NULL
  AND ((l.email_status = 'failed' AND l.email_error IN ('unavailable', 'rate_limited'))
    OR (l.email_status = 'pending' AND l.email_error IS NULL AND l.created_at < ?2)
    OR (l.email_status = 'pending' AND l.email_error LIKE 'retrying:%' AND CAST(substr(l.email_error, 10) AS INTEGER) < ?3))
ORDER BY l.created_at, l.id
LIMIT ?4`;

/** Changes the lead only if it still holds the values the run read; 0 changes means another run or writer came first. */
const CLAIM_SQL = "UPDATE leads SET email_status = 'pending', email_error = ?1 WHERE id = ?2 AND email_status = ?3 AND email_error IS ?4";
/** The send's result, written only over this run's own claim. */
const RESULT_SQL = "UPDATE leads SET email_status = ?1, email_error = ?2 WHERE id = ?3 AND email_status = 'pending' AND email_error = ?4";

interface RetryRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  service: string | null;
  message: string | null;
  email_status: string;
  email_error: string | null;
  slug: string;
  owner_email: string;
}

/** One run's counts, and the code of the send that stopped it. Codes and counts only: they go to the log. */
export interface RetryResult { read: number; claimed: number; sent: number; failed: number; stopped: boolean; code?: string }

/**
 * Emails again at most RETRY_PER_RUN leads, oldest first, and stops at the first send that fails: an outage or
 * Resend's quota then costs one try per run, not ten. A sent lead becomes 'sent' with no error, so the app's
 * "We could not email you" line goes away; a failed one stores its new code. form.ts's daily count is unchanged: it
 * counts rows, and a claimed or retried lead stays one row whose email_error is not 'daily_cap'.
 */
export async function retryLeadEmails(env: Env, now: number): Promise<RetryResult> {
  const { results } = await env.DB.prepare(RETRY_SQL)
    .bind(now - RETRY_WINDOW_MS, now - STALE_PENDING_MS, now - STALE_CLAIM_MS, RETRY_PER_RUN)
    .all<RetryRow>();
  const claim = `retrying:${now}`;
  const mailer = createMailer(env);
  const result: RetryResult = { read: results.length, claimed: 0, sent: 0, failed: 0, stopped: false };
  for (const row of results) {
    const claimed = await env.DB.prepare(CLAIM_SQL).bind(claim, row.id, row.email_status, row.email_error).run();
    if (claimed.meta.changes !== 1) continue;
    result.claimed += 1;
    let error: string | null = null;
    try {
      // Exactly the form's call (form.ts handleForm), from the stored lead: the same key and the same bytes.
      const lead = { name: row.name, phone: row.phone, email: row.email, service: row.service, message: row.message };
      await mailer.send(leadEmail({ to: row.owner_email, leadId: row.id, lead, siteUrl: siteUrl(env.ROOT_DOMAIN, row.slug) }));
    } catch (e) {
      error = e instanceof MailerError ? e.code : "internal";
    }
    await env.DB.prepare(RESULT_SQL).bind(error === null ? "sent" : "failed", error, row.id, claim).run();
    if (error !== null) {
      result.failed += 1;
      result.stopped = true;
      result.code = `email_${error}`;
      break;
    }
    result.sent += 1;
  }
  return result;
}
