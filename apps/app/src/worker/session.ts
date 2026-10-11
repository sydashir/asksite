import { ApiError, inBackground, rateLimit } from "@asksite/app-common";
import { sha256Hex, TOKEN_PATTERN, TTL } from "@asksite/core";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "./types.ts";

export const SESSION_COOKIE = "__Host-asksite_sid";
const LAST_SEEN_EVERY_MS = 3_600_000;

/** §4.4: host-only, https only, not readable by scripts, not sent on cross-site POSTs. */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${TTL.sessionMs / 1000}`;
}

export const EXPIRED_SESSION_COOKIE = `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

/**
 * The statement that stores a new session. Only the token's hash is stored, and only for an owner who is
 * not disabled, checked in the same statement: its meta.changes is 0 otherwise, so a disable that lands
 * after an earlier check can never leave a live session. The session stores the owner's auth_version
 * (0011_auth_version.sql), which requireOwner and every password write then require it to keep.
 * A password sign-in passes the hash it just verified and the auth_version read with it (`verified`): the
 * session is then a 'password' one (0010_owner_password.sql) and is stored only while the owner's hash and
 * auth_version are still those, so a password cleared or replaced during the check gives no session (IMP-2;
 * the version too, moderator 2026-10-11). Without it, the session is an emailed-link or invite one
 * (signed_in_with NULL) and takes the owner's auth_version as it is.
 */
export function insertSession(db: D1Database, idHash: string, ownerId: string, now: number, verified: { hash: string; authVersion: number } | null = null): D1PreparedStatement {
  const columns = "INSERT INTO sessions (id_hash, owner_id, created_at, expires_at, last_seen_at, signed_in_with, auth_version)";
  if (verified === null) {
    return db.prepare(`${columns} SELECT ?1, id, ?3, ?4, ?3, NULL, auth_version FROM owners WHERE id = ?2 AND disabled_at IS NULL`).bind(idHash, ownerId, now, now + TTL.sessionMs);
  }
  return db
    .prepare(`${columns} SELECT ?1, id, ?3, ?4, ?3, 'password', auth_version FROM owners WHERE id = ?2 AND disabled_at IS NULL AND password_hash = ?5 AND auth_version = ?6`)
    .bind(idHash, ownerId, now, now + TTL.sessionMs, verified.hash, verified.authVersion);
}

/** The hash of the session token in the request's cookie, or null when the cookie holds none that could be one. */
async function cookieSessionHash(c: Context<AppEnv>): Promise<string | null> {
  const token = getCookie(c, SESSION_COOKIE);
  return token === undefined || !TOKEN_PATTERN.test(token) ? null : sha256Hex(token);
}

/**
 * Sign-out (§4.4: "session (or none)"): deletes the session the request's cookie names, if any. It needs
 * no live session and no rate limit, so an expired, unknown or disabled owner's session, or an owner
 * over API_RL, can always sign out.
 */
export async function endSession(c: Context<AppEnv>): Promise<void> {
  const idHash = await cookieSessionHash(c);
  if (idHash !== null) await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(idHash).run();
}

/**
 * Session middleware for every signed-in route: 401 without a live session, 403 for a disabled owner. A session whose auth_version
 * is not its owner's (a password was set, replaced or cleared since it signed in: 0011_auth_version.sql) is refused like a missing
 * one, with the same 401. The middleware only reads: the batch that moved the version deletes such sessions, and the daily cron
 * deletes any left when they expire.
 */
export const requireOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
  const idHash = await cookieSessionHash(c);
  if (idHash === null) throw new ApiError("unauthenticated", "Please sign in");
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT o.id, o.email, o.disabled_at, s.last_seen_at
     FROM sessions s JOIN owners o ON o.id = s.owner_id
     WHERE s.id_hash = ? AND s.expires_at > ? AND s.auth_version = o.auth_version`,
  )
    .bind(idHash, now)
    .first<{ id: string; email: string; disabled_at: number | null; last_seen_at: number }>();
  if (row === null) throw new ApiError("unauthenticated", "Please sign in");
  if (row.disabled_at !== null) throw new ApiError("owner_disabled", "This account has been disabled. Contact us for help.");
  await rateLimit(c.env.API_RL, row.id);
  if (now - row.last_seen_at > LAST_SEEN_EVERY_MS) {
    inBackground(c.executionCtx, "last_seen_failed", c.env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").bind(now, idHash).run());
  }
  c.set("owner", { id: row.id, email: row.email });
  c.set("sessionHash", idHash);
  await next();
};
