import { ApiError } from "@asksite/app-common";
import { DUMMY_PASSWORD_HASH, hashIp, hashPassword, newToken, passwordKeys, sha256Hex, type OwnerView } from "@asksite/core";
import { PASSWORD_FAILED_SQL, PASSWORD_LOCKED_SQL, SKIP_CURRENT_SQL } from "./password-sql.ts";
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

/** The lock rows' detail for an email: keyed with IP_HASH_KEY, so the audit log never holds the address. */
async function lockDetail(env: Env, email: string): Promise<string> {
  return JSON.stringify({ emailHash: await hashIp(env.IP_HASH_KEY, `email:${email}`) });
}

/** Throws the lock's answer while `email` is locked (password-sql.ts). */
async function refuseIfLocked(db: D1Database, detail: string, now: number): Promise<void> {
  const row = await db.prepare(PASSWORD_LOCKED_SQL).bind(now, detail).first<{ locked: number }>();
  if (row?.locked === 1) throw new ApiError("login_locked", NO_MATCH);
}

/**
 * Password log-in: the lock first (a locked email is refused before any lookup or hash), then one derive against the owner's
 * hash or the dummy, and a wrong try's lock row. Right password: a new session for an owner who is not disabled (insertSession
 * checks that in the same statement) and its audit row, both in one batch.
 */
export async function passwordLogin(env: Env, email: string, password: string, now: number): Promise<{ owner: OwnerView; sessionToken: string }> {
  const detail = await lockDetail(env, email);
  await refuseIfLocked(env.DB, detail, now);
  const owner = await env.DB.prepare("SELECT id, email, password_hash FROM owners WHERE email = ?").bind(email).first<{ id: string; email: string; password_hash: string | null }>();
  if (!(await passwordMatches(password, owner?.password_hash ?? null)) || owner === null) {
    await env.DB.prepare(PASSWORD_FAILED_SQL).bind(now, detail).run();
    throw new ApiError("login_failed", NO_MATCH);
  }
  const sessionToken = newToken();
  const idHash = await sha256Hex(sessionToken);
  const [session] = await env.DB.batch([
    insertSession(env.DB, idHash, owner.id, now, "password"),
    env.DB
      .prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?, ?, 'auth.login', NULL, ? WHERE EXISTS (SELECT 1 FROM sessions WHERE id_hash = ?)")
      .bind(now, `owner:${owner.id}`, JSON.stringify({ method: "password" }), idHash),
  ]);
  if (session?.meta.changes !== 1) throw new ApiError("owner_disabled", OWNER_DISABLED);
  return { owner: { id: owner.id, email: owner.email }, sessionToken };
}

const WRONG_CURRENT = "Your current password is not right.";
/** DECIDED 2026-10-08 (moderator): the answer when the current password is left out but this session may not skip it. */
const NEED_LINK = "To set a new password without your current one, log in again with an email link.";
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
 * lock as log-in: a wrong one writes a lock row), unless this session signed in with an emailed link or an invite at most 15
 * minutes ago (RULED 2026-10-08: the link proved the inbox, so a forgotten password, or one a squatter set at sign-up, can be
 * replaced). Replacing ends the owner's other sessions (RULED Q3) in the same batch; this session stays. Each write applies
 * only while the stored hash is still the one this request read, so a change made elsewhere meanwhile is never overwritten.
 */
export async function setPassword(
  env: Env,
  owner: OwnerView,
  sessionHash: string,
  input: { currentPassword?: string | undefined; newPassword: string },
  now: number,
): Promise<{ replaced: boolean }> {
  const row = await env.DB.prepare(`SELECT o.password_hash, ${SKIP_CURRENT_SQL} AS skip_current FROM sessions s JOIN owners o ON o.id = s.owner_id WHERE s.id_hash = ?2`)
    .bind(now, sessionHash)
    .first<{ password_hash: string | null; skip_current: number }>();
  const current = row?.password_hash ?? null;
  if (current !== null) {
    if (input.currentPassword === undefined) {
      if (row?.skip_current !== 1) throw new ApiError("forbidden", NEED_LINK);
    } else {
      const detail = await lockDetail(env, owner.email);
      await refuseIfLocked(env.DB, detail, now);
      if (!(await passwordMatches(input.currentPassword, current))) {
        await env.DB.prepare(PASSWORD_FAILED_SQL).bind(now, detail).run();
        throw new ApiError("forbidden", WRONG_CURRENT);
      }
    }
  }
  const next = await hashPassword(input.newPassword);
  const stored = "EXISTS (SELECT 1 FROM owners WHERE id = ?1 AND password_hash = ?2)";
  const statements = [
    current === null
      ? env.DB.prepare("UPDATE owners SET password_hash = ?1 WHERE id = ?2 AND password_hash IS NULL").bind(next, owner.id)
      : env.DB.prepare("UPDATE owners SET password_hash = ?1 WHERE id = ?2 AND password_hash = ?3").bind(next, owner.id, current),
    env.DB
      .prepare(`INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?3, ?4, 'auth.password_set', NULL, ?5 WHERE ${stored}`)
      .bind(owner.id, next, now, `owner:${owner.id}`, JSON.stringify({ replaced: current !== null })),
  ];
  if (current !== null) statements.push(env.DB.prepare(`DELETE FROM sessions WHERE owner_id = ?1 AND id_hash != ?3 AND ${stored}`).bind(owner.id, next, sessionHash));
  const [updated] = await env.DB.batch(statements);
  if (updated?.meta.changes !== 1) throw new ApiError("conflict", PASSWORD_CHANGED_ELSEWHERE);
  return { replaced: current !== null };
}
