-- P4-21 item 1 (the moderator's exception for lane A, 2026-09-30): the review alert's daily count.

-- On every publish request the app counts the day's review requests across all sites (apps/app routes/publish.ts,
-- shouldAlert), filtering site_versions by requested_at; without an index that scans the whole table. The index covers
-- (requested_at, site_id, number), all the count reads of each of the day's versions, so it finds and counts them
-- without reading their rows, and the planner keeps it once ANALYZE statistics exist (D1 advises PRAGMA optimize,
-- which runs ANALYZE, after creating an index).
CREATE INDEX site_versions_requested ON site_versions(requested_at, site_id, number);
