import { ApiError, inBackground, logLine, magicLinkEmail, noteLog, rateLimit, readJson, runToEnd, sendReporting } from "@asksite/app-common";
import { AcceptInviteBody, hashIp, ipRateKey, LIMITS, LoginBody, newId, newToken, sha256Hex, TTL, utcDayStart, VerifyLoginBody, type OwnerView } from "@asksite/core";
import { Hono, type MiddlewareHandler } from "hono";
import { loginEmailsPerDay } from "../config.ts";
import { clientIp, mailerEnv } from "../db.ts";
import type { AppDeps } from "../deps.ts";
import { claimInvite } from "../invite-claim.ts";
import { endSession, EXPIRED_SESSION_COOKIE, insertSession, sessionCookie } from "../session.ts";
import { alertNearCap, countSentToday, sentToday } from "../sign-in-emails.ts";
import { networkDetail, sendSignupLink } from "../signup.ts";
import { NETWORK_ROW_SQL } from "../signup-sql.ts";
import { requireTurnstile } from "../turnstile.ts";
import type { AppEnv } from "../types.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const INVITE_INVALID = "This invite link has expired or was already used. Ask us for a new one.";
const TOKEN_INVALID = "This sign-in link has expired or was already used. Request a new one.";
const OWNER_DISABLED = "This account has been disabled. Contact us for help.";

/** AUTH_RL, keyed on the address, or its /64 for IPv6 (Plan 2 decision 27): one customer holds a whole /64. */
const authLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  await rateLimit(c.env.AUTH_RL, await hashIp(c.env.IP_HASH_KEY, ipRateKey(clientIp(c.req.raw))));
  await next();
};

/** /api/auth/*: invite acceptance, magic-link sign-in or self-serve sign-up, and sign-out (§4.4, §5.2). */
export function authRoutes(deps: AppDeps): Hono<AppEnv> {
  const auth = new Hono<AppEnv>();

  auth.post("/invite/accept", authLimit, async (c) => {
    const { token } = await readJson(c, AcceptInviteBody);
    const tokenHash = await sha256Hex(token);
    // Looked up by hash only: the claim is the one gate for used, revoked and expired invites.
    const invite = await c.env.DB
      .prepare("SELECT i.id, i.email, o.disabled_at FROM invites i LEFT JOIN owners o ON o.email = i.email WHERE i.token_hash = ?")
      .bind(tokenHash)
      .first<{ id: string; email: string; disabled_at: number | null }>();
    if (invite === null) throw new ApiError("invite_invalid", INVITE_INVALID);
    // (0) A disabled owner is refused before the token is spent.
    if (invite.disabled_at !== null) throw new ApiError("owner_disabled", OWNER_DISABLED);
    // From the claim to the batch, the work runs to its end even if the client goes away.
    const accepted = await runToEnd(c.executionCtx, acceptInvite(c.env.DB, invite, tokenHash, Date.now()));
    c.header("Set-Cookie", sessionCookie(accepted.sessionToken));
    return c.json({ owner: accepted.owner, siteId: accepted.siteId });
  });

  auth.post("/login", authLimit, async (c) => {
    const { email } = await readJson(c, LoginBody);
    // A11: the security check comes before any lookup, write or email, so its refusal says nothing about owners.
    await requireTurnstile(c, deps.siteverify);
    // Always the same answer, sent before any lookup, so neither the body nor the timing says
    // whether the address has an account, is new (a sign-up) or which cap applied.
    inBackground(c.executionCtx, "login_link_failed", sendLink(c.env, deps, email.trim().toLowerCase(), clientIp(c.req.raw), Date.now()));
    return c.json({ ok: true }, 202);
  });

  auth.post("/login/verify", authLimit, async (c) => {
    const { token } = await readJson(c, VerifyLoginBody);
    const tokenHash = await sha256Hex(token);
    // From the claim to the batch, the work runs to its end even if the client goes away.
    const signedIn = await runToEnd(c.executionCtx, verifyLogin(c.env.DB, tokenHash, Date.now()));
    c.header("Set-Cookie", sessionCookie(signedIn.sessionToken));
    return c.json({ owner: signedIn.owner });
  });

  // §4.4: a session or none, always 204 with the cookie expired. No requireOwner and no rate limiter
  // (neither AUTH_RL nor API_RL), so signing out always works; the Origin check still applies (app.ts).
  auth.post("/logout", async (c) => {
    try {
      await endSession(c);
    } catch (err) {
      // Even a failed DELETE signs the browser out: its cookie is expired below. But the row is the session: if it
      // stays, anyone who holds the token keeps access for up to 30 days (TTL.sessionMs), so the DELETE is tried once
      // more in the background, which logs its own line if that fails too. The request's one log line records the
      // first failure (the error's class name only).
      noteLog(c, { event: "session_delete_failed", error: err instanceof Error ? err.name : "unknown" });
      inBackground(c.executionCtx, "session_delete_retry_failed", endSession(c));
    }
    c.header("Set-Cookie", EXPIRED_SESSION_COOKIE);
    return c.body(null, 204);
  });

  return auth;
}

/** §5.2 invite steps (1) and (2): claim the token, then create the owner, site, invite links, session and audit row in one batch. */
async function acceptInvite(db: D1Database, invite: { id: string; email: string }, tokenHash: string, now: number) {
  // (1) Claim the token: exactly one request can win.
  if (!(await claimInvite(db, tokenHash, now))) throw new ApiError("invite_invalid", INVITE_INVALID);
  // (2) Owner, site, invite links, session and audit row in one transaction.
  const siteId = newId();
  const sessionToken = newToken();
  const sessionHash = await sha256Hex(sessionToken);
  // Every write below happens only for an owner who is not disabled and for an invite that is not revoked, both checked in
  // this transaction, so a disable or a revoke that lands after the claim leaves no owner, site, invite link, session or
  // audit row. The admin's revoke still reaches a claimed invite whose site_id is NULL, so the claim alone is not enough.
  const open = "EXISTS (SELECT 1 FROM invites WHERE id = ? AND revoked_at IS NULL)";
  const activeOwner = `FROM owners WHERE email = ? AND disabled_at IS NULL AND ${open}`;
  try {
    const results = await db.batch([
      // SQLite: an INSERT ... SELECT needs a WHERE clause before ON CONFLICT, or the parser reads ON as a join's.
      db
        .prepare(`INSERT INTO owners (id, email, created_at) SELECT ?, ?, ? WHERE ${open} ON CONFLICT(email) DO NOTHING`)
        .bind(newId(), invite.email, now, invite.id),
      db.prepare(`INSERT INTO sites (id, owner_id, created_at, updated_at) SELECT ?, id, ?, ? ${activeOwner}`).bind(siteId, now, now, invite.email, invite.id),
      db
        .prepare(`UPDATE invites SET owner_id = (SELECT id ${activeOwner}), site_id = ? WHERE id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 ${activeOwner})`)
        .bind(invite.email, invite.id, siteId, invite.id, invite.email, invite.id),
      db
        .prepare(`INSERT INTO sessions (id_hash, owner_id, created_at, expires_at, last_seen_at) SELECT ?, id, ?, ?, ? ${activeOwner}`)
        .bind(sessionHash, now, now + TTL.sessionMs, now, invite.email, invite.id),
      db
        .prepare(`INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?, 'owner:' || id, 'invite.accepted', ?, ? ${activeOwner}`)
        .bind(now, siteId, JSON.stringify({ inviteId: invite.id }), invite.email, invite.id),
      // Open sign-up (RULED 2026-10-07): accepting a sign-up link revokes the address's other unused sign-up links, so an
      // address gets one site from sign-up. Only for a sign-up link, and only when this accept made its session (an
      // active owner and an open invite); an admin's invite is never revoked here.
      db
        .prepare(
          `UPDATE invites SET revoked_at = ? WHERE email = ? AND created_by = 'signup' AND id != ? AND used_at IS NULL AND revoked_at IS NULL
             AND EXISTS (SELECT 1 FROM invites WHERE id = ? AND created_by = 'signup') AND EXISTS (SELECT 1 FROM sessions WHERE id_hash = ?)`,
        )
        .bind(now, invite.email, invite.id, invite.id, sessionHash),
      // What the batch did, read in the same transaction (A10: no RETURNING, and no reliance on each statement's meta.changes).
      // From the invite, so a revoked invite of a new address (no owner row) still has a row to read.
      db
        .prepare(
          `SELECT i.revoked_at IS NOT NULL AS revoked, o.id, o.email, EXISTS (SELECT 1 FROM sites WHERE id = ?) AS site, EXISTS (SELECT 1 FROM sessions WHERE id_hash = ?) AS session
           FROM invites i LEFT JOIN owners o ON o.email = i.email WHERE i.id = ?`,
        )
        .bind(siteId, sessionHash, invite.id),
    ]);
    const outcome = results[6]?.results[0] as { revoked: number; id: string | null; email: string | null; site: number; session: number } | undefined;
    if (outcome === undefined) throw new Error("invite row missing after invite accept");
    if (outcome.revoked === 1) throw new ApiError("invite_invalid", INVITE_INVALID);
    if (outcome.id === null || outcome.email === null) throw new Error("owner row missing after invite accept");
    if (outcome.site !== 1 || outcome.session !== 1) throw new ApiError("owner_disabled", OWNER_DISABLED);
    return { owner: { id: outcome.id, email: outcome.email } satisfies OwnerView, siteId, sessionToken };
  } catch (err) {
    // Release the token so the owner can simply click the link again, unless the batch saved:
    // it set site_id in the same transaction, and then the invite stays spent.
    await db.prepare("UPDATE invites SET used_at = NULL WHERE id = ? AND site_id IS NULL").bind(invite.id).run();
    throw err;
  }
}

/** Claims a sign-in token (§5.1), then stores the session and its audit row, both only for an owner who is not disabled. */
async function verifyLogin(db: D1Database, tokenHash: string, now: number): Promise<{ owner: OwnerView; sessionToken: string }> {
  // `changes = 1` means this request won. D1 documents `meta.changes`; it documents no RETURNING.
  const claim = await db
    .prepare("UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(now, tokenHash, now)
    .run();
  if (claim.meta.changes !== 1) throw new ApiError("token_invalid", TOKEN_INVALID);
  const owner = await db
    .prepare("SELECT o.id, o.email FROM login_tokens t JOIN owners o ON o.id = t.owner_id WHERE t.token_hash = ?")
    .bind(tokenHash)
    .first<OwnerView>();
  if (owner === null) throw new ApiError("token_invalid", TOKEN_INVALID);
  const sessionToken = newToken();
  const idHash = await sha256Hex(sessionToken);
  // insertSession is the disabled check: it stores nothing for a disabled owner, and the audit row needs the session.
  const [session] = await db.batch([
    insertSession(db, idHash, owner.id, now),
    db
      .prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?, ?, 'auth.login', NULL, NULL WHERE EXISTS (SELECT 1 FROM sessions WHERE id_hash = ?)")
      .bind(now, `owner:${owner.id}`, idHash),
  ]);
  if (session?.meta.changes !== 1) throw new ApiError("owner_disabled", OWNER_DISABLED);
  return { owner: { id: owner.id, email: owner.email }, sessionToken };
}

/**
 * Runs after the 202. A known owner gets a sign-in link, a disabled owner nothing, and an address with no owner a
 * self-serve sign-up link (open sign-up, DECIDED 2026-10-07: signup.ts).
 */
async function sendLink(env: Env, deps: AppDeps, email: string, ip: string, now: number): Promise<void> {
  const network = await networkDetail(env, ip);
  const owner = await env.DB.prepare("SELECT id, disabled_at FROM owners WHERE email = ?").bind(email).first<{ id: string; disabled_at: number | null }>();
  if (owner === null) return sendSignupLink(env, deps, email, network, now);
  // I3: an owner's request writes its network's row too (never refused by it), so the count says nothing about accounts.
  await env.DB.prepare(NETWORK_ROW_SQL).bind(now, network).run();
  if (owner.disabled_at !== null) return;
  return sendLoginLink(env, deps, { id: owner.id }, email, now);
}

/** Creates a token (within the per-owner caps and the day's cap for all owners) and emails the link. */
async function sendLoginLink(env: Env, deps: AppDeps, owner: { id: string }, email: string, now: number): Promise<void> {
  const mailer = deps.createMailer(mailerEnv(env));
  const token = newToken();
  const tokenHash = await sha256Hex(token);
  const dayStart = utcDayStart(now);
  // A11: LOGIN_EMAILS_PER_DAY (40) for all owners keeps most of Resend Free's 100 emails a day for leads.
  const perDay = loginEmailsPerDay(env.LOGIN_EMAILS_PER_DAY);
  // Every cap is an exact count in the same statement as the insert. The owner's own caps count every link; the day's
  // cap for all owners skips links kept after an "unavailable" send (B1-15, below) and counts sign-up emails (sentToday).
  const inserted = await env.DB.prepare(
    `INSERT INTO login_tokens (token_hash, owner_id, created_at, expires_at)
     SELECT ?1, ?2, ?3, ?4
     WHERE (SELECT COUNT(*) FROM login_tokens WHERE owner_id = ?2 AND created_at > ?5) < ?6
       AND (SELECT COUNT(*) FROM login_tokens WHERE owner_id = ?2 AND created_at > ?7) < ?8
       AND ${sentToday("?9")} < ?10`,
  )
    .bind(
      tokenHash,
      owner.id,
      now,
      now + TTL.loginTokenMs,
      now - HOUR_MS,
      LIMITS.loginTokensPerOwnerPerHour,
      now - DAY_MS,
      LIMITS.loginTokensPerOwnerPerDay,
      dayStart,
      perDay,
    )
    .run();
  if (inserted.meta.changes !== 1) {
    if ((await countSentToday(env.DB, dayStart)) >= perDay) logLine({ event: "login_email_cap_reached" });
    return;
  }
  const content = magicLinkEmail({ appOrigin: env.APP_ORIGIN, token });
  const failure = await sendReporting(mailer, { to: email, ...content, tag: "magic_link", idempotencyKey: `login:${tokenHash}` });
  if (failure === null) return alertNearCap(env, deps, perDay, now);
  // After "unavailable" (a 5xx, a timeout, a network failure or an answer with no email id) the provider may have
  // delivered the link (F26), so it stays valid and counts toward the owner's own caps: deleting it would leave the
  // owner a dead "expired or already used" link. It is marked with the time the send failed, so the day's cap for all
  // owners skips it and an outage cannot pause sign-in emails for every owner (B1-15). If the mark fails, the link stays
  // counted (the safe side) and the job's one failure line (login_link_failed) reports it. Any other failure: the link
  // was never sent, so it is deleted and uses up nothing.
  if (failure === "unavailable") await env.DB.prepare("UPDATE login_tokens SET send_failed_at = ? WHERE token_hash = ?").bind(Date.now(), tokenHash).run();
  else await env.DB.prepare("DELETE FROM login_tokens WHERE token_hash = ?").bind(tokenHash).run();
}
