-- Password accounts (USER ORDER 2026-10-08): an owner may sign up and log in with an email and a password.

-- The owner's password, stored only as a versioned PBKDF2 hash: pbkdf2-sha256$<iterations>$<salt base64>$<hash base64>
-- (packages/core/src/password.ts). NULL means the owner has no password and signs in with the emailed link, as every
-- owner did before this migration. Failed password tries for the 5-try lock are audit_log rows, so no table is added.
ALTER TABLE owners ADD COLUMN password_hash TEXT;

-- How a session signed in: 'password', or NULL for an emailed link or an invite (as every session before this migration).
-- RULED 2026-10-08: within 15 minutes of its sign-in (sessions.created_at), a link or invite session may set a new password
-- without the current one, because the link proved the inbox; a password session always needs the current one.
-- Both columns are nullable with no default: no table rewrite, and every existing row reads NULL.
ALTER TABLE sessions ADD COLUMN signed_in_with TEXT;
