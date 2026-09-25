import { ApiError, rateLimit } from "@asksite/app-common";
import { sha256Hex, TOKEN_PATTERN, TTL } from "@asksite/core";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "./types.ts";

export const SESSION_COOKIE = "__Host-asksite_sid";
const LAST_SEEN_EVERY_MS = 3_600_000;

/** §4.4: host-only, https only, not readable by scripts, not sent on cross-site POSTs. */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${TTL.sessionMs / 1000}`;
}

export const EXPIRED_SESSION_COOKIE = `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

/** The statement that stores a new session. Only the token's hash is stored. */
export function insertSession(db: D1Database, idHash: string, ownerId: string, now: number): D1PreparedStatement {
  return db
    .prepare("INSERT INTO sessions (id_hash, owner_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)")
    .bind(idHash, ownerId, now, now + TTL.sessionMs, now);
}

/** Session middleware for every signed-in route: 401 without a live session, 403 for a disabled owner. */
export const requireOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token === undefined || !TOKEN_PATTERN.test(token)) throw new ApiError("unauthenticated", "Please sign in");
  const idHash = await sha256Hex(token);
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
    c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").bind(now, idHash).run());
  }
  c.set("owner", { id: row.id, email: row.email });
  c.set("sessionHash", idHash);
  await next();
};
