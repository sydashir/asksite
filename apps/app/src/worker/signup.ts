import { logLine, sendReporting, signupInviteEmail } from "@asksite/app-common";
import { hashIp, ipRateKey, newId, newToken, sha256Hex, TTL, utcDayStart } from "@asksite/core";
import { loginEmailsPerDay } from "./config.ts";
import { mailerEnv } from "./db.ts";
import type { AppDeps } from "./deps.ts";
import { alertNearCap, countSentToday, sentToday } from "./sign-in-emails.ts";
import { NETWORK_SIGNUP_SQL } from "./signup-sql.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Open self sign-up limits (DECIDED 2026-10-07): per visitor network a UTC day, per address an hour and in 24 hours. */
const SIGNUPS_PER_NETWORK_PER_DAY = 3;
const SIGNUPS_PER_EMAIL_PER_HOUR = 1;
const SIGNUPS_PER_EMAIL_PER_DAY = 3;

/**
 * Runs after the 202 for an address with no owner: a self-serve invite (created_by 'signup', no admin) and its email. The
 * existing invite-accept path then creates the owner and the site. In order: the network's limit (its row counts even if
 * nothing is sent), then the invite within the address's limits and the day's cap for all sign-in emails, all counted in
 * the INSERT itself, then the email. A failed email deletes the invite: no live link, and it counts toward nothing.
 */
export async function sendSignupLink(env: Env, deps: AppDeps, email: string, ip: string, now: number): Promise<void> {
  const dayStart = utcDayStart(now);
  const perDay = loginEmailsPerDay(env.LOGIN_EMAILS_PER_DAY);
  // The same key as AUTH_RL's: the address, or its /64 for IPv6 (Plan 2 decision 27), hashed with IP_HASH_KEY.
  const detail = JSON.stringify({ ipHash: await hashIp(env.IP_HASH_KEY, ipRateKey(ip)) });
  const network = await env.DB.prepare(NETWORK_SIGNUP_SQL).bind(now, detail, dayStart, SIGNUPS_PER_NETWORK_PER_DAY).run();
  if (network.meta.changes !== 1) {
    logLine({ event: "signup_network_limit" });
    return;
  }
  const mailer = deps.createMailer(mailerEnv(env));
  const id = newId();
  const token = newToken();
  const inserted = await env.DB.prepare(
    `INSERT INTO invites (id, token_hash, email, created_by, created_at, expires_at)
     SELECT ?1, ?2, ?3, 'signup', ?4, ?5
     WHERE NOT EXISTS (SELECT 1 FROM owners WHERE email = ?3)
       AND (SELECT COUNT(*) FROM invites WHERE created_by = 'signup' AND email = ?3 AND created_at > ?6) < ?7
       AND (SELECT COUNT(*) FROM invites WHERE created_by = 'signup' AND email = ?3 AND created_at > ?8) < ?9
       AND ${sentToday("?10")} < ?11`,
  )
    .bind(
      id,
      await sha256Hex(token),
      email,
      now,
      now + TTL.inviteMs,
      now - HOUR_MS,
      SIGNUPS_PER_EMAIL_PER_HOUR,
      now - DAY_MS,
      SIGNUPS_PER_EMAIL_PER_DAY,
      dayStart,
      perDay,
    )
    .run();
  if (inserted.meta.changes !== 1) {
    // Which limit refused it, for the log line only: the day's cap logs as sign-in does, anything else as the address's.
    logLine({ event: (await countSentToday(env.DB, dayStart)) >= perDay ? "login_email_cap_reached" : "signup_email_limit" });
    return;
  }
  const content = signupInviteEmail({ appOrigin: env.APP_ORIGIN, token });
  const failure = await sendReporting(mailer, { to: email, ...content, tag: "signup_invite", idempotencyKey: `signup:${id}` });
  // Any failure: no email, no invite (as the admin's invite route does). The network's row still counts.
  if (failure !== null) await env.DB.prepare("DELETE FROM invites WHERE id = ?").bind(id).run();
  await alertNearCap(env, deps, perDay, now);
}
