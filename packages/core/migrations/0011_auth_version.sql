-- PWD-REDESIGN (moderator web-maker-d5, 2026-10-11): one version check closes the session and password race class (I1, I2, IMP-1, IMP-2).

-- owners.auth_version goes up by one on every write of password_hash: the first password, a replace, and the clear of an unconfirmed
-- sign-up password at the first emailed-link or invite sign-in (RULED I2). Each session stores its owner's auth_version when it is made
-- (apps/app/src/worker/session.ts insertSession, and the invite accept in routes/auth.ts). Every signed-in request (requireOwner) and
-- every password write requires the session's to equal the owner's, so a password write ends every other session: the session that
-- wrote takes the new value in the same batch, and the batch deletes the ended ones (apps/app/src/worker/password.ts, password-sql.ts).
ALTER TABLE owners ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;

-- NOT NULL with a constant DEFAULT, as ADD COLUMN requires ("If a NOT NULL constraint is specified, then the column must have a default
-- value other than NULL", sqlite.org/lang_altertable.html). No table rewrite: ADD COLUMN changes the schema text, and the same page names
-- only CHECK constraints and NOT NULL generated columns as reading the existing rows. A row stored before it reads the DEFAULT ("Missing values at the end of the record are filled in using the default value", sqlite.org/fileformat2.html),
-- so every existing owner and session reads 0 and every existing session stays valid (0 = 0).
