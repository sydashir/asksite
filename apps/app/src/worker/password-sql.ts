/**
 * The 5-try lock on password checks (USER ORDER 2026-10-08; RULED I1 2026-10-08): 5 wrong passwords for one email within 15
 * minutes stop password checks for that email for 15 minutes from the 5th. Every check first reserves a row in password_tries
 * (0010_owner_password.sql) with RESERVE_TRY_SQL, one statement that inserts only while the email is not locked, so concurrent
 * requests can never get more checks than the lock allows. A wrong password keeps its row as the failed try; a right one
 * deletes it. An unknown email reserves and locks the same way, so the lock says nothing about which emails have accounts.
 * The statement reads the password_tries_email index (password.workerd.test.ts checks the query plan). Its own module, with no
 * Worker types, so that test can import it.
 */
export const LOCK_TRIES = 5;
export const LOCK_WINDOW_MS = 15 * 60_000;

/** RULED 2026-10-08: how long after an emailed-link or invite sign-in that session may set a new password without the current one. */
export const LINK_RESET_WINDOW_MS = 15 * 60_000;

/** 1 when session `s` may set a new password without the current one: it signed in with a link or an invite (NULL) at most 15 minutes before ?1 (now). */
export const SKIP_CURRENT_SQL = `(s.signed_in_with IS NULL AND s.created_at >= ?1 - ${LINK_RESET_WINDOW_MS})`;

/**
 * Reserves one try for an email, unless it is locked: some try of the last 15 minutes was at least the 5th within the 15
 * minutes up to it, so the lock ends exactly 15 minutes after that try. ?1 the email's hash, ?2 now. meta.changes is 1 when
 * reserved (meta.last_row_id is the row), 0 when locked.
 */
export const RESERVE_TRY_SQL = `INSERT INTO password_tries (email_hash, at)
  SELECT ?1, ?2
  WHERE NOT EXISTS (
    SELECT 1 FROM password_tries f
    WHERE f.email_hash = ?1 AND f.at > ?2 - ${LOCK_WINDOW_MS}
      AND (SELECT COUNT(*) FROM password_tries g WHERE g.email_hash = ?1 AND g.at > f.at - ${LOCK_WINDOW_MS} AND g.at <= f.at) >= ${LOCK_TRIES}
  )`;

/** Gives back a reserved try whose password was right. ?1 the row's id. */
export const RELEASE_TRY_SQL = "DELETE FROM password_tries WHERE id = ?1";

/**
 * RULED I2 (2026-10-08): a password set at sign-up is unconfirmed (owners.password_unconfirmed = 1), since sign-up sends no
 * email. The account's first emailed-link or invite sign-in clears it and ends its password sessions, in the same batch as
 * that sign-in, and only once that sign-in's own session (?2, its id hash) is stored. `ownerId` is an SQL expression for the
 * owner's id over ?1 (the id itself, or a lookup by email). PWD-REDESIGN (2026-10-11): the clear is a password write, so it
 * adds one to owners.auth_version (0011_auth_version.sql); then, in this order, the sign-in's own session takes the owner's
 * auth_version as it now is (keepNewSessionSql: it was stored a moment earlier in this batch, with a fresh token, so it can
 * never be one the clear ended), and every session of the owner left with another version is deleted (endStaleSessionsSql).
 * While the mark is set every other session is a password one (a link or invite sign-in clears it), so these are the
 * password sessions RULED I2 ends.
 */
export const clearUnconfirmedSql = (ownerId: string): string => `UPDATE owners SET password_hash = NULL, password_unconfirmed = NULL, auth_version = auth_version + 1
  WHERE id = ${ownerId} AND password_unconfirmed = 1 AND EXISTS (SELECT 1 FROM sessions WHERE id_hash = ?2)`;
export const keepNewSessionSql = (ownerId: string): string => `UPDATE sessions SET auth_version = (SELECT auth_version FROM owners WHERE id = ${ownerId})
  WHERE id_hash = ?2 AND owner_id = ${ownerId}`;
export const endStaleSessionsSql = (ownerId: string): string => `DELETE FROM sessions WHERE owner_id = ${ownerId}
  AND auth_version != (SELECT auth_version FROM owners WHERE id = ${ownerId}) AND EXISTS (SELECT 1 FROM sessions WHERE id_hash = ?2)`;
