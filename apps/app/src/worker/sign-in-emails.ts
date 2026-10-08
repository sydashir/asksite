import { logLine, signInCapAlertEmail, trySend } from "@asksite/app-common";
import { utcDayStart } from "@asksite/core";
import { mailerEnv } from "./db.ts";
import type { AppDeps } from "./deps.ts";

/**
 * The day's sign-in emails for all owners (A11, LOGIN_EMAILS_PER_DAY), as one SQL expression over the parameter `day`
 * (the UTC day's start): the sign-in links made since then, except links kept after an "unavailable" send (B1-15), plus
 * the self-serve sign-up invites made since then (open sign-up, DECIDED 2026-10-07; created_by 'signup', which no admin
 * can be: an admin is an email address). A failed sign-up send deletes its invite, so it never counts. The admin's
 * numbers (apps/admin/src/worker/routes/sign-in.ts) count by this same rule.
 */
export const sentToday = (day: string): string =>
  `((SELECT COUNT(*) FROM login_tokens WHERE created_at >= ${day} AND send_failed_at IS NULL) + (SELECT COUNT(*) FROM invites WHERE created_by = 'signup' AND created_at >= ${day}))`;

/** The day's count at which the admins are told the cap is near: 80% of it (32 of 40). */
export const CAP_ALERT_SHARE = 0.8;

/** The day's count (sentToday) for the UTC day that starts at `dayStart`. */
export async function countSentToday(db: D1Database, dayStart: number): Promise<number> {
  return (await db.prepare(`SELECT ${sentToday("?1")} AS n`).bind(dayStart).first<{ n: number }>())?.n ?? 0;
}

/**
 * Runs after a sign-in or sign-up email, never before it: once the day's count reaches 80% of the cap, it emails every
 * address in ADMIN_NOTIFY_EMAILS, once per UTC day. The one-a-day rule is an audit row inserted only when the day has
 * none (INSERT ... WHERE NOT EXISTS); only the request whose insert changed a row sends. With no address configured it
 * logs and sends nothing. `cap` is the caller's loginEmailsPerDay value (read once per request: it logs a bad value).
 * It never throws: the owner's own email has gone out, so its failure is its own log line.
 */
export async function alertNearCap(env: Env, deps: AppDeps, cap: number, now: number): Promise<void> {
  try {
    await alertOnce(env, deps, cap, now);
  } catch (err) {
    logLine({ event: "signin_cap_alert_failed", error: err instanceof Error ? err.name : "unknown" });
  }
}

async function alertOnce(env: Env, deps: AppDeps, cap: number, now: number): Promise<void> {
  const dayStart = utcDayStart(now);
  const sent = await countSentToday(env.DB, dayStart);
  if (sent < Math.ceil(CAP_ALERT_SHARE * cap)) return;
  const claimed = await env.DB.prepare(
    `INSERT INTO audit_log (at, actor, action, site_id, detail_json)
     SELECT ?1, 'system', 'signin.cap_alert_sent', NULL, ?2
     WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE site_id IS NULL AND at >= ?3 AND action = 'signin.cap_alert_sent')`,
  )
    .bind(now, JSON.stringify({ sent, cap }), dayStart)
    .run();
  if (claimed.meta.changes !== 1) return;
  const recipients = env.ADMIN_NOTIFY_EMAILS.split(",").map((a) => a.trim().toLowerCase()).filter((a) => a !== "");
  logLine({ event: "signin_cap_alert", sent, cap, recipients: recipients.length });
  if (recipients.length === 0) return;
  const mailer = deps.createMailer(mailerEnv(env));
  const alert = signInCapAlertEmail({ sent, cap });
  await Promise.all(recipients.map((to) => trySend(mailer, { to, ...alert, tag: "admin_alert", idempotencyKey: `signin-cap:${dayStart}:${to}` })));
}
