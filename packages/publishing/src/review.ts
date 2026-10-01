import { livePointerKey, siteUrl } from "@asksite/core";
import { PublishError } from "./errors.ts";
import { auditIfChanged, copyLivePages, liveMetadata, removeOtherVersions, verifiedPages, writeLivePointer } from "./shared.ts";

interface VersionForReview {
  site_id: string;
  html_key: string;
  html_sha256: string;
  pages_json: string;
  document_json: string;
  status: string;
  slug: string | null;
  pending_version_id: string | null;
  live_version_id: string | null;
  taken_down_at: number | null;
}

/**
 * The admin's Approve. What the admin was shown is what goes live, every page of it at once (U2):
 * 1) the reviewed htmlSha256 (the digest of the pages) must equal the row's;
 * 2) a version that will be refused copies nothing: it must be the site's pending version (or the accepted
 *    retry: approved, live and not taken down);
 * 3) every stored page must still hash to the hash the row records;
 * 4) every page is copied to its own immutable LIVE key (nothing is served from those yet);
 * 5) one conditional D1 batch makes the version the live one (a retry after a failed step 6 is accepted);
 * 6) one write of the site's LIVE pointer, with the ids and the business name and phone as metadata, switches
 *    every page to the new version at once. The sites Worker serves a version only while D1 says it is live.
 *    If that write fails after step 5, live_copy_failed is thrown and approving the same version again finishes it;
 * 7) the other versions' LIVE pages are removed (best effort: nothing refers to them).
 */
export async function approveVersion(
  env: { DB: D1Database; WORK: R2Bucket; LIVE: R2Bucket; ROOT_DOMAIN: string },
  input: { versionId: string; htmlSha256: string; reviewer: string; note: string | null; indexable: boolean; now: number },
): Promise<{ siteId: string; slug: string; liveUrl: string }> {
  const { versionId, reviewer, note, indexable, now } = input;
  const db = env.DB;
  const row = await db
    .prepare(
      `SELECT v.site_id, v.html_key, v.html_sha256, v.pages_json, v.document_json, v.status, s.slug, s.pending_version_id, s.live_version_id, s.taken_down_at
       FROM site_versions v JOIN sites s ON s.id = v.site_id WHERE v.id = ?`,
    )
    .bind(versionId)
    .first<VersionForReview>();
  if (row === null || row.slug === null) throw new PublishError("version_not_pending");
  const { site_id: siteId, slug } = row;

  if (input.htmlSha256 !== row.html_sha256) throw new PublishError("integrity", { reason: "reviewed_hash_mismatch" });
  // The batch below stays the authoritative check; this only keeps a refused version from copying to LIVE.
  const pendingOne = row.status === "pending" && row.pending_version_id === versionId;
  const acceptedRetry = row.status === "approved" && row.live_version_id === versionId;
  if (row.taken_down_at !== null) throw new PublishError("site_taken_down");
  if (!pendingOne && !acceptedRetry) throw new PublishError("version_not_pending");
  const pages = await verifiedPages(env.WORK, { site_id: siteId, id: versionId, pages_json: row.pages_json, html_key: row.html_key, html_sha256: row.html_sha256 });
  const business = liveMetadata(row.document_json); // read before the batch: if it throws, nothing has changed
  await copyLivePages(env.LIVE, slug, { siteId, versionId }, pages);

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

  try {
    await writeLivePointer(env.LIVE, slug, { siteId, versionId, ...business });
  } catch {
    throw new PublishError("live_copy_failed", { versionId });
  }
  // A takedown by another admin can commit after the batch above and delete the pointer before this write lands.
  // The takedown wins: take the pointer back out, so the site's pages and its business name stay off the web.
  const after = await db.prepare("SELECT taken_down_at FROM sites WHERE id = ?").bind(siteId).first<{ taken_down_at: number | null }>();
  if (after === null || after.taken_down_at !== null) {
    await env.LIVE.delete(livePointerKey(slug));
    throw new PublishError("site_taken_down");
  }
  await removeOtherVersions(env.LIVE, slug, { siteId, versionId });
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
