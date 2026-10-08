-- Password accounts (USER ORDER 2026-10-08): an owner may sign up and log in with an email and a password.

-- The owner's password, stored only as a versioned PBKDF2 hash: pbkdf2-sha256$<iterations>$<salt base64>$<hash base64>
-- (packages/core/src/password.ts). NULL means the owner has no password and signs in with the emailed link, as every
-- owner did before this migration.
ALTER TABLE owners ADD COLUMN password_hash TEXT;

-- 1 while the password is the one set at sign-up, which proves nothing about the inbox (sign-up sends no email); NULL
-- otherwise. RULED 2026-10-08 (I2): the account's first emailed-link or invite sign-in clears such a password and ends its
-- password sessions, so a squatter who signed up with someone else's address keeps nothing.
ALTER TABLE owners ADD COLUMN password_unconfirmed INTEGER;

-- How a session signed in: 'password', or NULL for an emailed link or an invite (as every session before this migration).
-- RULED 2026-10-08: within 15 minutes of its sign-in (sessions.created_at), a link or invite session may set a new password
-- without the current one, because the link proved the inbox; a password session always needs the current one.
ALTER TABLE sessions ADD COLUMN signed_in_with TEXT;

-- The 5-try lock's tries (RULED 2026-10-08, I1): one row per password check, reserved BEFORE the check by one statement that
-- inserts only while the email is not locked, so a burst of requests cannot get more checks than the lock allows. A right
-- password deletes its own row; a wrong one stays as the failed try. email_hash is HMAC(IP_HASH_KEY, "email:" + email), so
-- the table never holds an address. The index serves the lock's two reads (apps/app/src/worker/password-sql.ts).
CREATE TABLE password_tries (
  id INTEGER PRIMARY KEY,
  email_hash TEXT NOT NULL,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX password_tries_email ON password_tries(email_hash, at);

-- The new columns are nullable with no default: no table rewrite, and every existing row reads NULL.
