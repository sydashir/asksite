import { ApiError } from "@asksite/app-common";
import { DUMMY_PASSWORD_HASH, hashIp, hashPassword, newToken, passwordKeys, sha256Hex, type OwnerView } from "@asksite/core";
import { RELEASE_TRY_SQL, RESERVE_TRY_SQL, SKIP_CURRENT_SQL } from "./password-sql.ts";
import { insertSession } from "./session.ts";

/** The one answer for a wrong email, a wrong password and the lock (USER ORDER 2026-10-08): it never says which. */
export const NO_MATCH = "That email and password don't match.";
const OWNER_DISABLED = "This account has been disabled. Contact us for help.";

/**
 * Whether `password` is the one `stored` holds. An owner with no password (null) is checked against DUMMY_PASSWORD_HASH, as is
 * an unknown email, so every answer costs one PBKDF2 derive and the timing says nothing. The comparison is constant-time:
 * crypto.subtle.timingSafeEqual, a workerd extension (developers.cloudflare.com/workers/runtime-apis/web-crypto/); both keys
 * are 32 bytes by construction (passwordKeys), as it requires (it throws on unequal lengths).
 */
export async function passwordMatches(password: string, stored: string | null): Promise<boolean> {
  const { derived, expected, valid } = await passwordKeys(password, stored ?? DUMMY_PASSWORD_HASH);
  return crypto.subtle.timingSafeEqual(derived, expected) && valid;
}

/** An email's key in password_tries: keyed with IP_HASH_KEY, so the table never holds the address. */
function emailKey(env: Env, email: string): Promise<string> {
  return hashIp(env.IP_HASH_KEY, `email:${email}`);
}

/**
 * Reserves one password check for an email before any hash is derived (password-sql.ts RESERVE_TRY_SQL), or throws the lock's
 * answer (`message`) without deriving. Returns the reserved row's id, which a right password gives back (RELEASE_TRY_SQL).
 */
async function reserveTry(db: D1Database, emailHash: string, now: number, message: string): Promise<number> {
  const reserved = await db.prepare(RESERVE_TRY_SQL).bind(emailHash, now).run();
  if (reserved.meta.changes !== 1) throw new ApiError("login_locked", message);
  return reserved.meta.last_row_id;
}

/**
 * Password log-in: a try is reserved first (a locked email is refused before any lookup or hash, RULED I1), then one derive
 * against the owner's hash or the dummy; a wrong password keeps its reserved try. Right password: a new session for an owner
 * who is not disabled (insertSession checks that in the same statement), its audit row and the try given back, in one batch.
 */
export async function passwordLogin(env: Env, email: string, password: string, now: number): Promise<{ owner: OwnerView; sessionToken: string }> {
  const tryId = await reserveTry(env.DB, await emailKey(env, email), now, NO_MATCH);
  const owner = await env.DB.prepare("SELECT id, email, password_hash FROM owners WHERE email = ?").bind(email).first<{ id: string; email: string; password_hash: string | null }>();
  if (!(await passwordMatches(password, owner?.password_hash ?? null)) || owner === null) throw new ApiError("login_failed", NO_MATCH);
  const sessionToken = newToken();
  const idHash = await sha256Hex(sessionToken);
  const [session] = await env.DB.batch([
    insertSession(env.DB, idHash, owner.id, now, "password"),
    env.DB
      .prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?, ?, 'auth.login', NULL, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id_hash = ?)")
      .bind(now, `owner:${owner.id}`, JSON.stringify({ method: "password" }), idHash),
    env.DB.prepare(RELEASE_TRY_SQL).bind(tryId),
  ]);
  if (session?.meta.changes !== 1) throw new ApiError("owner_disabled", OWNER_DISABLED);
  return { owner: { id: owner.id, email: owner.email }, sessionToken };
}

const WRONG_CURRENT = "Your current password is not right.";
/** DECIDED 2026-10-08 (moderator): the answer when the current password is left out but this session may not skip it. */
const NEED_LINK = "To set a new password without your current one, log in again with an email link.";
/** The same lock on the account page, where the log-in's words would not fit. */
const CHANGE_LOCKED = "Too many wrong passwords. Try again in 15 minutes, or log in again with an email link to set a new one.";
const PASSWORD_CHANGED_ELSEWHERE = "Your password was changed somewhere else. Reload the page and try again.";

/** What the account page needs: whether the owner has a password, and whether this session may set a new one without it. */
export async function passwordState(db: D1Database, sessionHash: string, now: number): Promise<{ hasPassword: boolean; skipCurrent: boolean }> {
  const row = await db
    .prepare(`SELECT o.password_hash IS NOT NULL AS has_password, ${SKIP_CURRENT_SQL} AS skip_current FROM sessions s JOIN owners o ON o.id = s.owner_id WHERE s.id_hash = ?2`)
    .bind(now, sessionHash)
    .first<{ has_password: number; skip_current: number }>();
  return { hasPassword: row?.has_password === 1, skipCurrent: row?.has_password === 1 && row.skip_current === 1 };
}

/**
 * Sets the signed-in owner's first password, or replaces it. Replacing needs the current one (checked under the same 5-try
 * lock as log-in: a try is reserved first, a wrong one keeps it), unless this session signed in with an emailed link or an
 * invite at most 15 minutes ago (RULED 2026-10-08: the link proved the inbox, so a forgotten password can be replaced).
 * Replacing ends the owner's other sessions (RULED Q3) in the same batch; this session stays. A password set from a link or
 * invite session is confirmed (RULED I2: password_unconfirmed cleared); one set from a password session leaves the mark as it
 * was, so a sign-up password cannot confirm itself. Each write applies only while the stored hash is still the one this
 * request read, so a change made elsewhere meanwhile is never overwritten.
 */
export async function setPassword(
  env: Env,
  owner: OwnerView,
  sessionHash: string,
  input: { currentPassword?: string | undefined; newPassword: string },
  now: number,
): Promise<{ replaced: boolean }> {
  const row = await env.DB.prepare(
    `SELECT o.password_hash, s.signed_in_with IS NULL AS link_session, ${SKIP_CURRENT_SQL} AS skip_current FROM sessions s JOIN owners o ON o.id = s.owner_id WHERE s.id_hash = ?2`,
  )
    .bind(now, sessionHash)
    .first<{ password_hash: string | null; link_session: number; skip_current: number }>();
  const current = row?.password_hash ?? null;
  let tryId: number | null = null;
  if (current !== null) {
    if (input.currentPassword === undefined) {
      if (row?.skip_current !== 1) throw new ApiError("forbidden", NEED_LINK);
    } else {
      tryId = await reserveTry(env.DB, await emailKey(env, owner.email), now, CHANGE_LOCKED);
      if (!(await passwordMatches(input.currentPassword, current))) throw new ApiError("forbidden", WRONG_CURRENT);
    }
  }
  const next = await hashPassword(input.newPassword);
  const confirmed = row?.link_session === 1 ? ", password_unconfirmed = NULL" : "";
  const stored = "EXISTS (SELECT 1 FROM owners WHERE id = ?1 AND password_hash = ?2)";
  const statements = [
    current === null
      ? env.DB.prepare(`UPDATE owners SET password_hash = ?1${confirmed} WHERE id = ?2 AND password_hash IS NULL`).bind(next, owner.id)
      : env.DB.prepare(`UPDATE owners SET password_hash = ?1${confirmed} WHERE id = ?2 AND password_hash = ?3`).bind(next, owner.id, current),
    env.DB
      .prepare(`INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?3, ?4, 'auth.password_set', NULL, ?5 WHERE ${stored}`)
      .bind(owner.id, next, now, `owner:${owner.id}`, JSON.stringify({ replaced: current !== null })),
  ];
  if (current !== null) statements.push(env.DB.prepare(`DELETE FROM sessions WHERE owner_id = ?1 AND id_hash != ?3 AND ${stored}`).bind(owner.id, next, sessionHash));
  if (tryId !== null) statements.push(env.DB.prepare(RELEASE_TRY_SQL).bind(tryId));
  const [updated] = await env.DB.batch(statements);
  if (updated?.meta.changes !== 1) throw new ApiError("conflict", PASSWORD_CHANGED_ELSEWHERE);
  return { replaced: current !== null };
}
