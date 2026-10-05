import { newId, siteUrl } from "@asksite/core";
import { PublishError } from "./errors.ts";
import { acquireLease, assertLease, auditIfChanged, copyLivePages, liveMetadata, releaseLease, removeOtherVersions, takeBackOwnPointer, verifiedPages, writeLivePointer } from "./shared.ts";

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
 * The admin's Approve. What the admin was shown is what goes live, every page of it at once (U2). It runs under the
 * site's lease (A16-4c: one admin action per site at a time; a busy site is site_busy), every D1 write carries the
 * lease token, and the lease is checked again right before the pointer write:
 * 1) the reviewed htmlSha256 (the digest of the pages) must equal the row's;
 * 2) a version that will be refused copies nothing: it must be the site's pending version (or the accepted
 *    retry: approved, live and not taken down);
 * 3) every stored page must still hash to the hash the row records;
 * 4) every page is copied to its own immutable LIVE key (nothing is served from those yet);
 * 5) one conditional D1 batch makes the version the live one (a retry after a failed step 6 is accepted);
 * 6) one write of the site's LIVE pointer, with the ids and the business name and phone as metadata, switches
 *    every page to the new version at once. The sites Worker serves a version only while D1 says it is live.
 *    If that write fails after step 5, live_copy_failed is thrown and approving the same version again finishes it;
 * 7) taken_down_at is read again, whether the write resolved or rejected: if a takedown committed meanwhile (only
 *    possible once the lease ran out), this action's own pointer is taken back out (takeBackOwnPointer: a pointer
 *    another action wrote meanwhile is left alone) and site_taken_down is thrown. A rejected write on a site that is
 *    not down is live_copy_failed; so is a failed read, after a best-effort take-back of its own pointer;
 * 8) the other versions' LIVE pages are removed (best effort: nothing refers to them).
 */
export async function approveVersion(
  env: { DB: D1Database; WORK: R2Bucket; LIVE: R2Bucket; ROOT_DOMAIN: string },
  input: { versionId: string; htmlSha256: string; reviewer: string; note: string | null; indexable: boolean; now: number },
): Promise<{ siteId: string; slug: string; liveUrl: string }> {
  const { versionId, reviewer, note, indexable, now } = input;
  const db = env.DB;
  const owner = await db.prepare("SELECT site_id FROM site_versions WHERE id = ?").bind(versionId).first<{ site_id: string }>();
  if (owner === null) throw new PublishError("version_not_pending");
  const siteId = owner.site_id;
  const token = await acquireLease(db, siteId, now, "version_not_pending");
  try {
    return await approveUnderLease(env, { ...input, siteId, token });
  } finally {
    await releaseLease(db, siteId, token);
  }
}

async function approveUnderLease(
  env: { DB: D1Database; WORK: R2Bucket; LIVE: R2Bucket; ROOT_DOMAIN: string },
  input: { versionId: string; htmlSha256: string; reviewer: string; note: string | null; indexable: boolean; now: number; siteId: string; token: string },
): Promise<{ siteId: string; slug: string; liveUrl: string }> {
  const { versionId, reviewer, note, indexable, now, siteId, token } = input;
  const db = env.DB;
  // Read after the lease is taken: what another action changed before it finished is seen.
  const row = await db
    .prepare(
      `SELECT v.site_id, v.html_key, v.html_sha256, v.pages_json, v.document_json, v.status, s.slug, s.pending_version_id, s.live_version_id, s.taken_down_at
       FROM site_versions v JOIN sites s ON s.id = v.site_id WHERE v.id = ?`,
    )
    .bind(versionId)
    .first<VersionForReview>();
  if (row === null || row.slug === null) throw new PublishError("version_not_pending");
  const { slug } = row;

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
    db.prepare("UPDATE sites SET live_version_id = ?, pending_version_id = NULL, indexable = ?, updated_at = ? WHERE id = ? AND pending_version_id = ? AND taken_down_at IS NULL AND admin_lock = ?")
      .bind(versionId, indexable ? 1 : 0, now, siteId, versionId, token),
    db.prepare(`UPDATE site_versions SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM sites WHERE id = ? AND live_version_id = ? AND admin_lock = ?)`)
      .bind(reviewer, now, note, versionId, siteId, versionId, token),
    auditIfChanged(db, { at: now, actor: `admin:${reviewer}`, action: "version.approved", siteId, detail: { versionId, indexable } }),
  ]);

  if (results[1]?.meta.changes !== 1) {
    await assertLease(db, siteId, token); // a fenced write that changed nothing under a lost lease is not "already live"
    const state = await db
      .prepare("SELECT v.status, s.live_version_id, s.taken_down_at FROM site_versions v JOIN sites s ON s.id = v.site_id WHERE v.id = ?")
      .bind(versionId)
      .first<{ status: string; live_version_id: string | null; taken_down_at: number | null }>();
    const alreadyLive = state !== null && state.status === "approved" && state.live_version_id === versionId && state.taken_down_at === null;
    if (!alreadyLive) throw new PublishError(state !== null && state.taken_down_at !== null ? "site_taken_down" : "version_not_pending");
  }

  await assertLease(db, siteId, token); // R2 cannot be conditioned on D1 (residual: see assertLease)
  const writeId = newId(); // this call's own pointer write: its take-back removes only that
  let putRejected = false;
  try {
    await writeLivePointer(env.LIVE, slug, { siteId, versionId, ...business }, writeId);
  } catch {
    putRejected = true; // the write may still have landed: the read below decides, in both cases
  }
  // A takedown by another admin can commit after the batch above (the lease lasting, none can; after it ran out, one
  // can), its pointer deletes done before this write lands. The takedown wins: take this write's pointer back out, so the
  // site's pages and its business name stay off the web; a pointer another action wrote since (a restore that has not
  // cleared yet) is not ours to delete (takeBackOwnPointer). If the delete fails, the pointer stays until the takedown is
  // run again: say so in the log (ids only) and refuse.
  let after: { taken_down_at: number | null } | null;
  try {
    after = await db.prepare("SELECT taken_down_at FROM sites WHERE id = ?").bind(siteId).first<{ taken_down_at: number | null }>();
  } catch {
    // Unconfirmed: the pointer may have landed on a site that is down. Take it out (approving again rewrites it).
    await takeBackOwnPointer(env.LIVE, slug, writeId, { code: "pointer_unconfirmed", siteId, versionId });
    throw new PublishError("live_copy_failed", { versionId });
  }
  if (after === null || after.taken_down_at !== null) {
    await takeBackOwnPointer(env.LIVE, slug, writeId, { code: "takedown_pointer_left", siteId, versionId });
    throw new PublishError("site_taken_down");
  }
  if (putRejected) throw new PublishError("live_copy_failed", { versionId });
  await removeOtherVersions(env.LIVE, db, slug, { siteId, versionId }, token);
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
