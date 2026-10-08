import { ApiError, logLine, secondsUntilUtcMidnight, sendReporting, signupInviteEmail } from "@asksite/app-common";
import { hashIp, hashPassword, ipRateKey, newId, newToken, sha256Hex, TTL, utcDayStart, type OwnerView } from "@asksite/core";
import { loginEmailsPerDay } from "./config.ts";
import { mailerEnv } from "./db.ts";
import type { AppDeps } from "./deps.ts";
import { insertSession } from "./session.ts";
import { alertNearCap, countSentToday, sentToday } from "./sign-in-emails.ts";
import { NETWORK_SIGNUP_SQL } from "./signup-sql.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Open self sign-up limits (DECIDED 2026-10-07): per visitor network a UTC day, per address an hour and in 24 hours. */
const SIGNUPS_PER_NETWORK_PER_DAY = 3;
const SIGNUPS_PER_EMAIL_PER_HOUR = 1;
const SIGNUPS_PER_EMAIL_PER_DAY = 3;
/** I1 (DECIDED 2026-10-07): sign-ups may use at most half of the day's cap (20 of 40), so sign-in always keeps the rest. */
const signupsPerDay = (perDay: number): number => Math.floor(perDay / 2);

/** A request's network row detail: the same key as AUTH_RL's (the address, or its /64 for IPv6, Plan 2 decision 27), hashed with IP_HASH_KEY. */
export async function networkDetail(env: Env, ip: string): Promise<string> {
  return JSON.stringify({ ipHash: await hashIp(env.IP_HASH_KEY, ipRateKey(ip)) });
}

/**
 * Runs after the 202 for an address with no owner: a self-serve invite (created_by 'signup', no admin) and its email. The
 * existing invite-accept path then creates the owner and the site. In order: the network's limit (its row counts even if
 * nothing is sent), then the invite within the address's limits, the sign-ups' half of the day (I1) and the day's cap for
 * all sign-in emails, all counted in the INSERT itself, then the email. A failed email deletes the invite: no live link,
 * and it counts toward nothing. `network` is networkDetail's value.
 */
export async function sendSignupLink(env: Env, deps: AppDeps, email: string, network: string, now: number): Promise<void> {
  const dayStart = utcDayStart(now);
  const perDay = loginEmailsPerDay(env.LOGIN_EMAILS_PER_DAY);
  const row = await env.DB.prepare(NETWORK_SIGNUP_SQL).bind(now, network, dayStart, SIGNUPS_PER_NETWORK_PER_DAY).run();
  if (row.meta.changes !== 1) {
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
       AND (SELECT COUNT(*) FROM invites WHERE created_by = 'signup' AND created_at >= ?10) < ?12
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
      signupsPerDay(perDay),
    )
    .run();
  if (inserted.meta.changes !== 1) {
    // Which limit refused it, for the log line only: the day's cap logs as sign-in does, then the sign-ups' half, else the address's.
    const signups = await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE created_by = 'signup' AND created_at >= ?").bind(dayStart).first<{ n: number }>();
    const event = (await countSentToday(env.DB, dayStart)) >= perDay ? "login_email_cap_reached" : (signups?.n ?? 0) >= signupsPerDay(perDay) ? "signup_cap_reached" : "signup_email_limit";
    logLine({ event });
    return;
  }
  const content = signupInviteEmail({ appOrigin: env.APP_ORIGIN, token });
  const failure = await sendReporting(mailer, { to: email, ...content, tag: "signup_invite", idempotencyKey: `signup:${id}` });
  // Any failure: no email, no invite (as the admin's invite route does). The network's row still counts.
  if (failure !== null) await env.DB.prepare("DELETE FROM invites WHERE id = ?").bind(id).run();
  await alertNearCap(env, deps, perDay, now);
}

/** USER ORDER 2026-10-08: the brief's words for an email that already has an account (it reveals that: an accepted trade-off). */
export const ACCOUNT_EXISTS = "There's already an account for this email. Log in, or email yourself a log-in link.";
/** The network's limit, the day's sign-up cap or the day's cap for all sign-in emails refused the sign-up; all reset at 00:00 UTC. */
const SIGNUPS_FULL = "We can't open new accounts right now. Please try again tomorrow.";

/**
 * Password sign-up (USER ORDER 2026-10-08; RULED 2026-10-08 point 6): no email is sent; the owner, the site and a 30-day
 * session are made at once. In order: the network's limit (a refusable row for every attempt, so /signup's "already an
 * account" answer cannot be asked faster than sign-ups), then the existing-account answer, then one batch, a transaction, so an
 * error leaves no partial account. The batch's first statement records the sign-up as a self-serve invite ('signup', spent at
 * once, never emailed) only within the sign-ups' half of the day (I1) and the day's cap for all sign-in emails, which count it
 * as written (DECIDED 2026-10-08: they now limit account creation; the per-address limits are left out, as no email is sent).
 * Every later statement is keyed on the NEW owner's id, which only this batch can create, so an existing owner (a race) never
 * gets a session, a site or a password from it.
 */
export async function signUpWithPassword(env: Env, email: string, password: string, network: string, now: number): Promise<{ owner: OwnerView; siteId: string; sessionToken: string }> {
  const dayStart = utcDayStart(now);
  const full = () => new ApiError("rate_limited", SIGNUPS_FULL, { retryAfter: secondsUntilUtcMidnight(now) });
  const row = await env.DB.prepare(NETWORK_SIGNUP_SQL).bind(now, network, dayStart, SIGNUPS_PER_NETWORK_PER_DAY).run();
  if (row.meta.changes !== 1) {
    logLine({ event: "signup_network_limit" });
    throw full();
  }
  if ((await env.DB.prepare("SELECT 1 AS found FROM owners WHERE email = ?").bind(email).first()) !== null) throw new ApiError("conflict", ACCOUNT_EXISTS);
  const perDay = loginEmailsPerDay(env.LOGIN_EMAILS_PER_DAY);
  const inviteId = newId();
  const ownerId = newId();
  const siteId = newId();
  const sessionToken = newToken();
  const sessionHash = await sha256Hex(sessionToken);
  const passwordHash = await hashPassword(password);
  const db = env.DB;
  const [, , , , session, , , outcome] = await db.batch([
    db
      .prepare(
        `INSERT INTO invites (id, token_hash, email, created_by, created_at, expires_at, used_at)
         SELECT ?1, ?2, ?3, 'signup', ?4, ?4, ?4
         WHERE NOT EXISTS (SELECT 1 FROM owners WHERE email = ?3)
           AND (SELECT COUNT(*) FROM invites WHERE created_by = 'signup' AND created_at >= ?5) < ?6
           AND ${sentToday("?5")} < ?7`,
      )
      .bind(inviteId, await sha256Hex(newToken()), email, now, dayStart, signupsPerDay(perDay), perDay),
    // SQLite: an INSERT ... SELECT needs a WHERE clause before ON CONFLICT, or the parser reads ON as a join's.
    db
      // The password is unconfirmed (RULED I2): the account's first emailed-link or invite sign-in clears it (auth.ts).
      .prepare("INSERT INTO owners (id, email, created_at, password_hash, password_unconfirmed) SELECT ?1, ?2, ?3, ?4, 1 WHERE EXISTS (SELECT 1 FROM invites WHERE id = ?5) ON CONFLICT(email) DO NOTHING")
      .bind(ownerId, email, now, passwordHash, inviteId),
    db.prepare("INSERT INTO sites (id, owner_id, created_at, updated_at) SELECT ?1, id, ?2, ?2 FROM owners WHERE id = ?3").bind(siteId, now, ownerId),
    db.prepare("UPDATE invites SET owner_id = ?1, site_id = ?2 WHERE id = ?3 AND EXISTS (SELECT 1 FROM owners WHERE id = ?1)").bind(ownerId, siteId, inviteId),
    insertSession(db, sessionHash, ownerId, now, passwordHash),
    db
      .prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?1, 'owner:' || id, 'owner.signed_up', ?2, ?3 FROM owners WHERE id = ?4")
      .bind(now, siteId, JSON.stringify({ inviteId, method: "password" }), ownerId),
    // As accepting a sign-up link does (auth.ts acceptInvite): the address's other unused sign-up links are revoked, so it gets one site from sign-up.
    db
      .prepare(
        "UPDATE invites SET revoked_at = ?1 WHERE email = ?2 AND created_by = 'signup' AND id != ?3 AND used_at IS NULL AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM sessions WHERE id_hash = ?4)",
      )
      .bind(now, email, inviteId, sessionHash),
    // What the batch did, read in the same transaction (A10: no RETURNING).
    db
      .prepare("SELECT EXISTS (SELECT 1 FROM invites WHERE id = ?1) AS recorded, EXISTS (SELECT 1 FROM owners WHERE email = ?2 AND id != ?3) AS taken")
      .bind(inviteId, email, ownerId),
  ]);
  const done = outcome?.results[0] as { recorded: number; taken: number } | undefined;
  if (done === undefined) throw new Error("no outcome after password sign-up");
  if (done.taken === 1) throw new ApiError("conflict", ACCOUNT_EXISTS);
  if (done.recorded !== 1) {
    logLine({ event: (await countSentToday(env.DB, dayStart)) >= perDay ? "login_email_cap_reached" : "signup_cap_reached" });
    throw full();
  }
  if (session?.meta.changes !== 1) throw new Error("no session after password sign-up");
  return { owner: { id: ownerId, email }, siteId, sessionToken };
}
