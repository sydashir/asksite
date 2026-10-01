-- A16-4c: one admin action per site at a time. A lease: the action that holds admin_lock (a random token) until
-- admin_lock_until (epoch ms, the caller's clock) is the only one that may change the site's live state; every
-- write of such an action is conditioned on its token (packages/publishing/src/shared.ts). An action that dies
-- frees the site when its lease runs out. Both columns are NULL while no action runs.
-- Numbered 0006 by the moderator; Plan 4's next migration is 0007.
ALTER TABLE sites ADD COLUMN admin_lock TEXT;
ALTER TABLE sites ADD COLUMN admin_lock_until INTEGER;
