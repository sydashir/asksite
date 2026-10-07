-- P4-21 (the moderator's exception for lane A, 2026-09-30): upload reservations.

-- An upload's row is reserved before its billed Images transform runs, and counts toward both upload caps from then
-- on. reserved_at is when it was reserved (Unix epoch ms), and NULL on every other row. A reservation ends as a photo
-- or as a counted failure (reserved_at back to NULL), is deleted after a failure that is ours, or, left behind by a
-- request that died, is aged out into a counted failure once 10 minutes old. Nothing lists a reserved row as a photo.
-- Nullable with no default: no table rewrite, and every existing row reads NULL (no reservation).
ALTER TABLE uploads ADD COLUMN reserved_at INTEGER;
