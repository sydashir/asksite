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
 * after an earlier check can never leave a live session.
 */
export function insertSession(db: D1Database, idHash: string, ownerId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sessions (id_hash, owner_id, created_at, expires_at, last_seen_at)
       SELECT ?1, id, ?3, ?4, ?3 FROM owners WHERE id = ?2 AND disabled_at IS NULL`,
    )
    .bind(idHash, ownerId, now, now + TTL.sessionMs);
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

/** Session middleware for every signed-in route: 401 without a live session, 403 for a disabled owner. */
export const requireOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
  const idHash = await cookieSessionHash(c);
  if (idHash === null) throw new ApiError("unauthenticated", "Please sign in");
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT o.id, o.email, o.disabled_at, s.last_seen_at
     FROM sessions s JOIN owners o ON o.id = s.owner_id
     WHERE s.id_hash = ? AND s.expires_at > ?`,
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
