import { ApiError, inBackground, logLine, magicLinkEmail, rateLimit, readJson, runToEnd, trySend } from "@asksite/app-common";
import { AcceptInviteBody, hashIp, ipRateKey, LIMITS, LoginBody, newId, newToken, sha256Hex, TTL, utcDayStart, VerifyLoginBody, type OwnerView } from "@asksite/core";
import { Hono, type MiddlewareHandler } from "hono";
import { clientIp, mailerEnv } from "../db.ts";
import type { AppDeps } from "../deps.ts";
import { EXPIRED_SESSION_COOKIE, insertSession, requireOwner, sessionCookie } from "../session.ts";
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

/** /api/auth/*: invite acceptance, magic-link sign-in and sign-out (§4.4, §5.2). */
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
    // whether the address has an account or which cap applied.
    inBackground(c.executionCtx, "login_link_failed", sendLoginLink(c.env, deps, email.trim().toLowerCase(), Date.now()));
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

  // Needs a session, so the per-owner API_RL in requireOwner applies instead of the per-address AUTH_RL.
  auth.post("/logout", requireOwner, async (c) => {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(c.get("sessionHash")).run();
    c.header("Set-Cookie", EXPIRED_SESSION_COOKIE);
    return c.body(null, 204);
  });

  return auth;
}

/** §5.2 invite steps (1) and (2): claim the token, then create the owner, site, invite links, session and audit row in one batch. */
async function acceptInvite(db: D1Database, invite: { id: string; email: string }, tokenHash: string, now: number) {
  // (1) Claim the token: exactly one request can win.
  const claim = await db
    .prepare("UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?")
    .bind(now, tokenHash, now)
    .run();
  if (claim.meta.changes !== 1) throw new ApiError("invite_invalid", INVITE_INVALID);
  // (2) Owner, site, invite links, session and audit row in one transaction.
  const siteId = newId();
  const sessionToken = newToken();
  const sessionHash = await sha256Hex(sessionToken);
  const ownerOf = "(SELECT id FROM owners WHERE email = ?)";
  try {
    const results = await db.batch([
      db.prepare("INSERT INTO owners (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING").bind(newId(), invite.email, now),
      db.prepare(`INSERT INTO sites (id, owner_id, created_at, updated_at) VALUES (?, ${ownerOf}, ?, ?)`).bind(siteId, invite.email, now, now),
      db.prepare(`UPDATE invites SET owner_id = ${ownerOf}, site_id = ? WHERE id = ?`).bind(invite.email, siteId, invite.id),
      // Only for an owner who is not disabled, checked in this transaction: a disable that lands after step (0) leaves no session.
      db
        .prepare("INSERT INTO sessions (id_hash, owner_id, created_at, expires_at, last_seen_at) SELECT ?, id, ?, ?, ? FROM owners WHERE email = ? AND disabled_at IS NULL")
        .bind(sessionHash, now, now + TTL.sessionMs, now, invite.email),
      db
        .prepare(`INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (?, 'owner:' || ${ownerOf}, 'invite.accepted', ?, ?)`)
        .bind(now, invite.email, siteId, JSON.stringify({ inviteId: invite.id })),
      db.prepare("SELECT id, email FROM owners WHERE email = ?").bind(invite.email),
    ]);
    if (results[3]?.meta.changes !== 1) throw new ApiError("owner_disabled", OWNER_DISABLED);
    const owner = results[5]?.results[0] as OwnerView | undefined;
    if (owner === undefined) throw new Error("owner row missing after invite accept");
    return { owner: { id: owner.id, email: owner.email }, siteId, sessionToken };
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

/** Runs after the 202: create a token (within the per-owner caps and the day's cap for all owners) and email the link. */
async function sendLoginLink(env: Env, deps: AppDeps, email: string, now: number): Promise<void> {
  const owner = await env.DB.prepare("SELECT id FROM owners WHERE email = ? AND disabled_at IS NULL").bind(email).first<{ id: string }>();
  if (owner === null) return;
  const mailer = deps.createMailer(mailerEnv(env));
  const token = newToken();
  const tokenHash = await sha256Hex(token);
  const dayStart = utcDayStart(now);
  // A11: LOGIN_EMAILS_PER_DAY (40) for all owners keeps most of Resend Free's 100 emails a day for leads.
  const perDay = Number(env.LOGIN_EMAILS_PER_DAY);
  // Every cap is an exact count in the same statement as the insert.
  const inserted = await env.DB.prepare(
    `INSERT INTO login_tokens (token_hash, owner_id, created_at, expires_at)
     SELECT ?1, ?2, ?3, ?4
     WHERE (SELECT COUNT(*) FROM login_tokens WHERE owner_id = ?2 AND created_at > ?5) < ?6
       AND (SELECT COUNT(*) FROM login_tokens WHERE owner_id = ?2 AND created_at > ?7) < ?8
       AND (SELECT COUNT(*) FROM login_tokens WHERE created_at >= ?9) < ?10`,
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
    const today = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_tokens WHERE created_at >= ?").bind(dayStart).first<{ n: number }>();
    if ((today?.n ?? 0) >= perDay) logLine({ event: "login_email_cap_reached" });
    return;
  }
  const content = magicLinkEmail({ appOrigin: env.APP_ORIGIN, token });
  const sent = await trySend(mailer, { to: email, ...content, tag: "magic_link", idempotencyKey: `login:${tokenHash}` });
  // A link that was never sent does not use up one of the owner's links, nor one of the day's.
  if (!sent) await env.DB.prepare("DELETE FROM login_tokens WHERE token_hash = ?").bind(tokenHash).run();
}
