import { liveKey, siteUrl } from "@asksite/core";
import { PublishError } from "./errors.ts";
import { auditIfChanged, HTML_TYPE, verifiedVersionBytes } from "./shared.ts";

interface VersionForReview {
  site_id: string;
  html_key: string;
  html_sha256: string;
  slug: string | null;
}

/**
 * The admin's Approve. What the admin was shown is what goes live:
 * 1) the reviewed htmlSha256 must equal the row's, and the stored bytes must still hash to it;
 * 2) one conditional D1 batch makes it the live version (a retry after a failed step 3 is accepted);
 * 3) the same bytes are copied to LIVE. The sites Worker serves them only while D1 says live.
 */
export async function approveVersion(
  env: { DB: D1Database; WORK: R2Bucket; LIVE: R2Bucket; ROOT_DOMAIN: string },
  input: { versionId: string; htmlSha256: string; reviewer: string; note: string | null; indexable: boolean; now: number },
): Promise<{ siteId: string; slug: string; liveUrl: string }> {
  const { versionId, reviewer, note, indexable, now } = input;
  const db = env.DB;
  const row = await db
    .prepare("SELECT v.site_id, v.html_key, v.html_sha256, s.slug FROM site_versions v JOIN sites s ON s.id = v.site_id WHERE v.id = ?")
    .bind(versionId)
    .first<VersionForReview>();
  if (row === null || row.slug === null) throw new PublishError("version_not_pending");
  const { site_id: siteId, slug } = row;

  if (input.htmlSha256 !== row.html_sha256) throw new PublishError("integrity", { reason: "reviewed_hash_mismatch" });
  const bytes = await verifiedVersionBytes(env.WORK, row.html_key, row.html_sha256);
  if (bytes === null) throw new PublishError("integrity", { reason: "stored_bytes_mismatch" });

  const results = await db.batch([
    db.prepare("UPDATE sites SET live_version_id = ?, pending_version_id = NULL, indexable = ?, updated_at = ? WHERE id = ? AND pending_version_id = ? AND taken_down_at IS NULL")
      .bind(versionId, indexable ? 1 : 0, now, siteId, versionId),
    db.prepare("UPDATE site_versions SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM sites WHERE id = ? AND live_version_id = ?)")
      .bind(reviewer, now, note, versionId, siteId, versionId),
    auditIfChanged(db, { at: now, actor: `admin:${reviewer}`, action: "version.approved", siteId, detail: { versionId, indexable } }),
  ]);

  if (results[1]?.meta.changes !== 1) {
    const state = await db
      .prepare("SELECT v.status, s.live_version_id, s.taken_down_at FROM site_versions v JOIN sites s ON s.id = v.site_id WHERE v.id = ?")
      .bind(versionId)
      .first<{ status: string; live_version_id: string | null; taken_down_at: number | null }>();
    const alreadyLive = state !== null && state.status === "approved" && state.live_version_id === versionId && state.taken_down_at === null;
    if (!alreadyLive) throw new PublishError(state !== null && state.taken_down_at !== null ? "site_taken_down" : "version_not_pending");
  }

  await env.LIVE.put(liveKey(slug), bytes, { httpMetadata: { contentType: HTML_TYPE }, customMetadata: { siteId, versionId, sha256: row.html_sha256 } });
  return { siteId, slug, liveUrl: siteUrl(env.ROOT_DOMAIN, slug) };
}

/** The admin's Reject: the pending version becomes "rejected" with the note; the site has nothing in review. */
export async function rejectVersion(
  env: { DB: D1Database },
  input: { versionId: string; reviewer: string; note: string; now: number },
): Promise<{ siteId: string }> {
  const { versionId, reviewer, note, now } = input;
  const db = env.DB;
  const row = await db.prepare("SELECT site_id FROM site_versions WHERE id = ?").bind(versionId).first<{ site_id: string }>();
  if (row === null) throw new PublishError("version_not_pending");
  const siteId = row.site_id;

  const results = await db.batch([
    db.prepare("UPDATE site_versions SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = 'pending'")
      .bind(reviewer, now, note, versionId),
    auditIfChanged(db, { at: now, actor: `admin:${reviewer}`, action: "version.rejected", siteId, detail: { versionId } }),
    db.prepare("UPDATE sites SET pending_version_id = NULL, updated_at = ? WHERE id = ? AND pending_version_id = ?").bind(now, siteId, versionId),
  ]);
  if (results[0]?.meta.changes !== 1) throw new PublishError("version_not_pending");
  return { siteId };
}
