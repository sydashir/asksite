import { ApiError, auditStatement, magicLinkEmail, rateLimit, readJson, trySend } from "@asksite/app-common";
import { AcceptInviteBody, hashIp, ipRateKey, LIMITS, LoginBody, newId, newToken, sha256Hex, TTL, VerifyLoginBody, type OwnerView } from "@asksite/core";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { clientIp, mailerEnv } from "../db.ts";
import type { AppDeps } from "../deps.ts";
import { EXPIRED_SESSION_COOKIE, insertSession, SESSION_COOKIE, sessionCookie } from "../session.ts";
import type { AppEnv } from "../types.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** /api/auth/*: invite acceptance, magic-link sign-in and sign-out (§4.4, §5.2). */
export function authRoutes(deps: AppDeps): Hono<AppEnv> {
  const auth = new Hono<AppEnv>();

  auth.use("*", async (c, next) => {
    // Keyed on the address, or its /64 for IPv6 (Plan 2 decision 27): one customer holds a whole /64.
    await rateLimit(c.env.AUTH_RL, await hashIp(c.env.IP_HASH_KEY, ipRateKey(clientIp(c.req.raw))));
    await next();
  });

  auth.post("/invite/accept", async (c) => {
    const { token } = await readJson(c, AcceptInviteBody);
    const db = c.env.DB;
    const now = Date.now();
    const tokenHash = await sha256Hex(token);
    // Looked up by hash only: the claim below is the one gate for used, revoked and expired invites.
    const invite = await db
      .prepare("SELECT i.id, i.email, o.disabled_at FROM invites i LEFT JOIN owners o ON o.email = i.email WHERE i.token_hash = ?")
      .bind(tokenHash)
      .first<{ id: string; email: string; disabled_at: number | null }>();
    if (invite === null) throw new ApiError("invite_invalid", "This invite link has expired or was already used. Ask us for a new one.");
    // (0) A disabled owner is refused before the token is spent.
    if (invite.disabled_at !== null) throw new ApiError("owner_disabled", "This account has been disabled. Contact us for help.");
    // (1) Claim the token: exactly one request can win.
    const claim = await db
      .prepare("UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?")
      .bind(now, tokenHash, now)
      .run();
    if (claim.meta.changes !== 1) throw new ApiError("invite_invalid", "This invite link has expired or was already used. Ask us for a new one.");
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
        db
          .prepare(`INSERT INTO sessions (id_hash, owner_id, created_at, expires_at, last_seen_at) VALUES (?, ${ownerOf}, ?, ?, ?)`)
          .bind(sessionHash, invite.email, now, now + TTL.sessionMs, now),
        db
          .prepare(`INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (?, 'owner:' || ${ownerOf}, 'invite.accepted', ?, ?)`)
          .bind(now, invite.email, siteId, JSON.stringify({ inviteId: invite.id })),
        db.prepare("SELECT id, email FROM owners WHERE email = ?").bind(invite.email),
      ]);
      const owner = results[5]?.results[0] as OwnerView | undefined;
      if (owner === undefined) throw new Error("owner row missing after invite accept");
      c.header("Set-Cookie", sessionCookie(sessionToken));
      return c.json({ owner: { id: owner.id, email: owner.email }, siteId });
    } catch (err) {
      // Release the token so the owner can simply click the link again.
      await db.prepare("UPDATE invites SET used_at = NULL WHERE id = ?").bind(invite.id).run();
      throw err;
    }
  });

  auth.post("/login", async (c) => {
    const { email } = await readJson(c, LoginBody);
    const address = email.trim().toLowerCase();
    // Always the same answer, sent before any lookup, so neither the body nor the timing says
    // whether the address has an account.
    c.executionCtx.waitUntil(sendLoginLink(c.env, deps, address, Date.now()));
    return c.json({ ok: true }, 202);
  });

  auth.post("/login/verify", async (c) => {
    const { token } = await readJson(c, VerifyLoginBody);
    const db = c.env.DB;
    const now = Date.now();
    const tokenHash = await sha256Hex(token);
    // Claim the token with the §5.1 conditional update (`changes = 1` means this request won), then
    // read its owner. D1 documents `meta.changes`; it documents no RETURNING.
    const claim = await db
      .prepare("UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
      .bind(now, tokenHash, now)
      .run();
    if (claim.meta.changes !== 1) throw new ApiError("token_invalid", "This sign-in link has expired or was already used. Request a new one.");
    const owner = await db
      .prepare("SELECT o.id, o.email, o.disabled_at FROM login_tokens t JOIN owners o ON o.id = t.owner_id WHERE t.token_hash = ?")
      .bind(tokenHash)
      .first<{ id: string; email: string; disabled_at: number | null }>();
    if (owner === null) throw new ApiError("token_invalid", "This sign-in link has expired or was already used. Request a new one.");
    if (owner.disabled_at !== null) throw new ApiError("owner_disabled", "This account has been disabled. Contact us for help.");
    const sessionToken = newToken();
    await db.batch([
      insertSession(db, await sha256Hex(sessionToken), owner.id, now),
      auditStatement(db, { at: now, actor: `owner:${owner.id}`, action: "auth.login", siteId: null }),
    ]);
    c.header("Set-Cookie", sessionCookie(sessionToken));
    return c.json({ owner: { id: owner.id, email: owner.email } });
  });

  auth.post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token !== undefined) await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256Hex(token)).run();
    c.header("Set-Cookie", EXPIRED_SESSION_COOKIE);
    return c.body(null, 204);
  });

  return auth;
}

/** Runs after the 202: create a token (within the per-owner caps) and email the link. */
async function sendLoginLink(env: Env, deps: AppDeps, email: string, now: number): Promise<void> {
  const owner = await env.DB.prepare("SELECT id FROM owners WHERE email = ? AND disabled_at IS NULL").bind(email).first<{ id: string }>();
  if (owner === null) return;
  const token = newToken();
  const inserted = await env.DB.prepare(
    `INSERT INTO login_tokens (token_hash, owner_id, created_at, expires_at)
     SELECT ?1, ?2, ?3, ?4
     WHERE (SELECT COUNT(*) FROM login_tokens WHERE owner_id = ?2 AND created_at > ?5) < ?6
       AND (SELECT COUNT(*) FROM login_tokens WHERE owner_id = ?2 AND created_at > ?7) < ?8`,
  )
    .bind(
      await sha256Hex(token),
      owner.id,
      now,
      now + TTL.loginTokenMs,
      now - HOUR_MS,
      LIMITS.loginTokensPerOwnerPerHour,
      now - DAY_MS,
      LIMITS.loginTokensPerOwnerPerDay,
    )
    .run();
  if (inserted.meta.changes !== 1) return;
  const content = magicLinkEmail({ appOrigin: env.APP_ORIGIN, token });
  await trySend(deps.createMailer(mailerEnv(env)), {
    to: email,
    ...content,
    tag: "magic_link",
    idempotencyKey: `login:${await sha256Hex(token)}`,
  });
}
