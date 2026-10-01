-- A16: a site has up to 5 pages, so a version is up to 5 stored pages. pages_json is canonicalJson of
-- VersionPages (packages/core/src/pages.ts): each page's id and the SHA-256 of its exact bytes, in page
-- order. html_sha256 becomes pagesDigest(pages), one digest over every page, which the admin approves;
-- html_key stays Home's WORK key. A row written before A16 keeps '[]', which VersionPages refuses, so
-- such a version can never be approved or restored.
-- Numbered 0005 because Plan 4 holds 0003 and 0004 on its branches. The files are independent and
-- wrangler applies migrations by file name, so a fresh database gets 0001 to 0005 in order.
ALTER TABLE site_versions ADD COLUMN pages_json TEXT NOT NULL DEFAULT '[]';
