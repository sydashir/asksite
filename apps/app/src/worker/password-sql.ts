/**
 * The 5-try lock on password log-in (USER ORDER 2026-10-08): 5 wrong passwords for one email within 15 minutes stop password
 * log-in for that email for 15 minutes from the 5th. Each wrong try is one audit_log row (no new table): action
 * 'auth.password_failed', detail { emailHash }, where emailHash is keyed with IP_HASH_KEY, so the log never holds the email. An
 * unknown email gets rows and locks the same way, so the lock says nothing about which emails have accounts. A try refused by
 * the lock writes no row. Both statements read the audit_site (site_id, at) index (password.workerd.test.ts checks the query
 * plan). Their own module, with no Worker types, so that test can import them.
 */
export const LOCK_TRIES = 5;
export const LOCK_WINDOW_MS = 15 * 60_000;

/** RULED 2026-10-08: how long after an emailed-link or invite sign-in that session may set a new password without the current one. */
export const LINK_RESET_WINDOW_MS = 15 * 60_000;

/** 1 when session `s` may set a new password without the current one: it signed in with a link or an invite (NULL) at most 15 minutes before ?1 (now). */
export const SKIP_CURRENT_SQL = `(s.signed_in_with IS NULL AND s.created_at >= ?1 - ${LINK_RESET_WINDOW_MS})`;

/** ?1 now, ?2 the detail ({ emailHash }). */
export const PASSWORD_FAILED_SQL = `INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (?1, 'login', 'auth.password_failed', NULL, ?2)`;

/**
 * 1 while the email is locked: some wrong try of the last 15 minutes was at least the 5th within the 15 minutes up to it, so
 * the lock ends exactly 15 minutes after that try. ?1 now, ?2 the detail ({ emailHash }).
 */
export const PASSWORD_LOCKED_SQL = `SELECT EXISTS (
    SELECT 1 FROM audit_log f
    WHERE f.site_id IS NULL AND f.at > ?1 - ${LOCK_WINDOW_MS} AND f.action = 'auth.password_failed' AND f.detail_json = ?2
      AND (SELECT COUNT(*) FROM audit_log g
           WHERE g.site_id IS NULL AND g.at > f.at - ${LOCK_WINDOW_MS} AND g.at <= f.at AND g.action = 'auth.password_failed' AND g.detail_json = ?2) >= ${LOCK_TRIES}
  ) AS locked`;
