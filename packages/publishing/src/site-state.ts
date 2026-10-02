import { TAKEDOWN_REVIEW_NOTE, canonicalJson, livePointerKey, liveSitePrefix, siteUrl } from "@asksite/core";
import { PublishError } from "./errors.ts";
import { acquireLease, assertLease, type AuditAction, auditIfChanged, copyLivePages, deletePrefix, LEASE_HELD, liveMetadata, releaseLease, removeOtherVersions, verifiedPages, writeLivePointer } from "./shared.ts";

/**
 * The admin's Take down, under the site's lease (A16-4c: one admin action per site at a time, site_busy otherwise;
 * every D1 write carries the lease token; the lease is checked right before each R2 delete of the pointer or the
 * pages). A takedown may wait up to ADMIN_LEASE_MS behind a hung action (accepted: it answers site_busy, retry). In order:
 * 1) the site's LIVE pointer is deleted first: it stops every page at once, cached ones included (a cached page's
 *    key names its version, and the Worker reads the pointer before it looks at the cache). If that fails the
 *    takedown fails with nothing changed in D1, and the admin retries;
 * 2) the D1 batch, which also stops the pages and photos being served (the sites Worker checks D1 on a cache miss);
 * 3) every LIVE page of the site is deleted, and 4) MEDIA is purged, both as defence in depth, and both are
 *    retried by calling takeDown again (it is idempotent).
 * Only the first call writes the takedown row. A later call whose purge deletes anything (an object,
 * or an upload not yet marked deleted) writes its own row, so no deletion goes unlogged (design §4.5).
 * Under the lease no restore can interleave, so a requested purge always runs after the batch.
 */
export async function takeDown(
  env: { DB: D1Database; LIVE: R2Bucket; MEDIA: R2Bucket },
  input: { siteId: string; reviewer: string; reason: string; purgeMedia: boolean; now: number },
): Promise<void> {
  const { siteId, now } = input;
  const token = await acquireLease(env.DB, siteId, now, "site_not_found");
  try {
    await takeDownUnderLease(env, { ...input, token });
  } finally {
    await releaseLease(env.DB, siteId, token);
  }
}

async function takeDownUnderLease(
  env: { DB: D1Database; LIVE: R2Bucket; MEDIA: R2Bucket },
  input: { siteId: string; reviewer: string; reason: string; purgeMedia: boolean; now: number; token: string },
): Promise<void> {
  const { siteId, reviewer, reason, purgeMedia, now, token } = input;
  const db = env.DB;
  const site = await db.prepare("SELECT slug FROM sites WHERE id = ?").bind(siteId).first<{ slug: string | null }>();
  if (site === null) throw new PublishError("site_not_found");

  if (site.slug !== null) {
    await assertLease(db, siteId, token);
    await env.LIVE.delete(livePointerKey(site.slug));
  }

  const actor = `admin:${reviewer}`;
  const [, takenDown] = await db.batch([
    db.prepare(`UPDATE site_versions SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE site_id = ? AND status = 'pending' AND ${LEASE_HELD}`)
      .bind(reviewer, now, TAKEDOWN_REVIEW_NOTE, siteId, siteId, token),
    db.prepare("UPDATE sites SET taken_down_at = ?, takedown_reason = ?, pending_version_id = NULL, updated_at = ? WHERE id = ? AND taken_down_at IS NULL AND admin_lock = ?")
      .bind(now, reason, now, siteId, token),
    auditIfChanged(db, { at: now, actor, action: "site.taken_down", siteId, detail: { reason, purgeMedia } }),
  ]);
  if (takenDown?.meta.changes !== 1) await assertLease(db, siteId, token); // 0 rows: already down (fine) or the lease was lost

  // Again, after the batch: an approve that ran between the first delete and the batch may have written a pointer
  // (once its lease ran out; under the lease none can). Between this second delete and the end, no pointer is left.
  if (site.slug !== null) {
    await assertLease(db, siteId, token);
    await env.LIVE.delete(livePointerKey(site.slug));
    await assertLease(db, siteId, token);
    await deletePrefix(env.LIVE, liveSitePrefix(site.slug));
  }
  if (purgeMedia) {
    const deletedObjects = await deletePrefix(env.MEDIA, `${siteId}/`);
    const markDeleted = db.prepare(`UPDATE uploads SET deleted_at = ? WHERE site_id = ? AND deleted_at IS NULL AND ${LEASE_HELD}`).bind(now, siteId, siteId, token);
    // This call's takedown row (written only when it took the site down) already records the purge.
    const firstCall = takenDown?.meta.changes === 1;
    const [marked] = await db.batch(firstCall ? [markDeleted] : [markDeleted, auditLaterPurge(db, { at: now, actor, siteId, reason }, deletedObjects)]);
    if (marked?.meta.changes === 0) await assertLease(db, siteId, token);
  }
}

/**
 * The row for a purge by a later takedown call. Written only when the uploads UPDATE just before it
 * in the same batch marked a row (SQLite changes()) or the purge deleted an object: a soft-deleted
 * photo keeps its object until a purge (design §8), so either can happen without the other.
 */
function auditLaterPurge(
  db: D1Database,
  entry: { at: number; actor: string; siteId: string; reason: string },
  deletedObjects: number,
): D1PreparedStatement {
  const action: AuditAction = "site.taken_down";
  return db
    .prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?, ?, ?, ?, ? WHERE changes() > 0 OR ? > 0")
    .bind(entry.at, entry.actor, action, entry.siteId, canonicalJson({ reason: entry.reason, purgeMedia: true, repeat: true }), deletedObjects);
}

/**
 * The admin's Restore of a TAKEN-DOWN site, under the site's lease (A16-4c). `expectedTakenDownAt` is the taken_down_at
 * the admin's page showed: if the site was restored and taken down again since, it differs and the answer is
 * site_taken_down (taken_down_again) before any R2 write; a site that is not taken down is already restored and comes
 * back with the normal result, its pointer checked first (a missing or wrong one is healed: `healed`). Otherwise: copies every page of the live version, verified, back to LIVE and
 * writes the pointer (D1 still says taken down: on an edge-cache MISS the Worker checks D1 and does not serve it, but a page
 * copy already in the edge cache under that version, s-maxage=60 from before the takedown, can be served with no D1 check
 * once the pointer exists), then clears taken_down_at, fenced on the expected time, the copied version and the lease.
 * Every take-back asks D1 first (one helper): a site still down, gone or unreadable loses the pointer; a site that is
 * live (another restore made it live, after this one outlived its lease) keeps it. If the clear changes nothing: down,
 * the pointer is taken back out; either way site_busy (lease_lost). If it throws, D1 is asked (it can commit a batch and
 * still throw): a committed clear keeps the pointer and succeeds, a live site with another version is left alone
 * (lease_lost), a clear that is not there (or a D1 that cannot answer) takes the pointer back out and rethrows. A
 * rejected pointer write: down or unreadable, the pointer is taken back out and the answer is live_copy_failed (the site
 * stays down: call it again); live, the pointer is left and the answer is site_busy (lease_lost).
 * RESIDUAL: see pointerBackIfDown (a re-read before another restore's clear commits).
 * Retry-safe: a retry after a failure is the same call again; a site that is already restored is checked, and a missing
 * or wrong pointer is healed (the pages copied again, the pointer written: `healed` is true), a right one is left alone.
 * Takes ROOT_DOMAIN (not in the design's signature) because it returns the live URL, and MEDIA to
 * count the page's photos a purge deleted (Decision 29): the page still goes back up. A live site's pages are
 * copied again by copyLivePagesAgain.
 */
export async function restore(
  env: { DB: D1Database; LIVE: R2Bucket; WORK: R2Bucket; MEDIA: R2Bucket; ROOT_DOMAIN: string },
  input: { siteId: string; reviewer: string; expectedTakenDownAt: number; now: number },
): Promise<{ liveUrl: string; missingPhotos: number; healed: boolean }> {
  const { siteId, now } = input;
  const token = await acquireLease(env.DB, siteId, now, "site_not_found");
  try {
    return await restoreUnderLease(env, { ...input, token });
  } finally {
    await releaseLease(env.DB, siteId, token);
  }
}

interface LiveSiteRow {
  slug: string | null;
  taken_down_at: number | null;
  live_version_id: string | null;
  html_key: string | null;
  html_sha256: string | null;
  pages_json: string | null;
  document_json: string | null;
}

/** The site and its live version's row (null: no such site). */
function readLiveSite(db: D1Database, siteId: string): Promise<LiveSiteRow | null> {
  return db
    .prepare("SELECT s.slug, s.taken_down_at, s.live_version_id, v.html_key, v.html_sha256, v.pages_json, v.document_json FROM sites s LEFT JOIN site_versions v ON v.id = s.live_version_id WHERE s.id = ?")
    .bind(siteId)
    .first<LiveSiteRow>();
}

async function restoreUnderLease(
  env: { DB: D1Database; LIVE: R2Bucket; WORK: R2Bucket; MEDIA: R2Bucket; ROOT_DOMAIN: string },
  input: { siteId: string; reviewer: string; expectedTakenDownAt: number; now: number; token: string },
): Promise<{ liveUrl: string; missingPhotos: number; healed: boolean }> {
  const { siteId, reviewer, expectedTakenDownAt, now, token } = input;
  const db = env.DB;
  const site = await readLiveSite(db, siteId);
  if (site === null) throw new PublishError("site_not_found");
  const { slug, live_version_id: versionId, html_key: key, html_sha256: sha256, pages_json: pagesJson, document_json: documentJson } = site;
  if (slug === null || versionId === null || key === null || sha256 === null || pagesJson === null || documentJson === null) throw new PublishError("not_live");
  // Already restored (by this admin's earlier call or another's, or by a clear that committed and threw): the normal
  // result. The pointer is checked first (under the lease): a missing or wrong one is healed, or the site would stay dark.
  if (site.taken_down_at === null) {
    const pointer = await env.LIVE.head(livePointerKey(slug));
    const healed = pointer === null || pointer.customMetadata?.["versionId"] !== versionId;
    if (healed) await copyAndPoint(env, { siteId, slug, versionId, key, sha256, pagesJson, documentJson, token });
    return { liveUrl: siteUrl(env.ROOT_DOMAIN, slug), missingPhotos: await missingPhotos(env.MEDIA, env.ROOT_DOMAIN, documentJson), healed };
  }
  // Taken down again since the admin's page was shown: the admin decides again, on a fresh page.
  if (site.taken_down_at !== expectedTakenDownAt) throw new PublishError("site_taken_down", { reason: "taken_down_again" });

  const pages = await verifiedPages(env.WORK, { site_id: siteId, id: versionId, pages_json: pagesJson, html_key: key, html_sha256: sha256 });
  await copyLivePages(env.LIVE, slug, { siteId, versionId }, pages);
  await assertLease(db, siteId, token); // R2 cannot be conditioned on D1 (residual: see assertLease)
  // The pointer is out (or may be) and must not stay on a site D1 says is down: the take-backs below remove it, best effort.
  // Not lease-checked: a check here could leave a pointer on a taken-down site.
  const pointerBack = async (): Promise<void> => {
    try {
      await env.LIVE.delete(livePointerKey(slug));
    } catch {
      console.error(JSON.stringify({ code: "takedown_pointer_left", siteId, versionId }));
    }
  };
  // The one take-back all three paths below use. It asks D1 first (D1 can commit a batch and still throw, and an action
  // that outlived its lease may find another restore already made the site live: that restore's pointer is not ours to delete).
  // Down, gone or unreadable: the pointer is taken back and null is returned. Live: the pointer is left alone and the row is returned.
  // RESIDUAL: if this re-read lands BEFORE another restore's clear commits (that restore has already written its pointer),
  // it still says down, this take-back removes that pointer, and the other restore's clear then makes the site live with no
  // pointer. Only possible when this action outlived its lease (over ADMIN_LEASE_MS); Restore again or Copy the live pages
  // again heals it (`healed: true`).
  const pointerBackIfDown = async (): Promise<{ taken_down_at: number | null; live_version_id: string | null } | null> => {
    let after: { taken_down_at: number | null; live_version_id: string | null } | null = null;
    try {
      after = await db.prepare("SELECT taken_down_at, live_version_id FROM sites WHERE id = ?").bind(siteId).first<{ taken_down_at: number | null; live_version_id: string | null }>();
    } catch {
      // Unconfirmed: treated as down (the admin restores again, which heals a pointer taken out of a live site).
    }
    if (after === null || after.taken_down_at !== null) {
      await pointerBack();
      return null;
    }
    return after;
  };
  const business = liveMetadata(documentJson);
  try {
    await writeLivePointer(env.LIVE, slug, { siteId, versionId, ...business });
  } catch {
    // The write may have landed before it rejected. Still down: taken back, the admin calls again. Live (another restore won): left alone.
    if ((await pointerBackIfDown()) === null) throw new PublishError("live_copy_failed", { versionId });
    throw new PublishError("site_busy", { reason: "lease_lost" });
  }
  let cleared: D1Result[] | null;
  try {
    cleared = await db.batch([
      db.prepare("UPDATE sites SET taken_down_at = NULL, takedown_reason = NULL, updated_at = ? WHERE id = ? AND taken_down_at = ? AND live_version_id = ? AND admin_lock = ?")
        .bind(now, siteId, expectedTakenDownAt, versionId, token),
      auditIfChanged(db, { at: now, actor: `admin:${reviewer}`, action: "site.restored", siteId, detail: { versionId } }),
    ]);
  } catch (error) {
    // D1 can commit a batch and still throw (versions.ts): a committed clear keeps the pointer.
    const after = await pointerBackIfDown();
    if (after === null) throw error;
    // Live with another version: only after a lost lease. That action's own pointer write decides, not this one.
    if (after.live_version_id !== versionId) throw new PublishError("site_busy", { reason: "lease_lost" });
    cleared = null; // the clear committed: keep the pointer
  }
  if (cleared !== null && cleared[0]?.meta.changes !== 1) {
    await pointerBackIfDown(); // down: taken back; live (another restore won): left alone
    throw new PublishError("site_busy", { reason: "lease_lost" });
  }
  await removeOtherVersions(env.LIVE, db, slug, { siteId, versionId }, token);
  return { liveUrl: siteUrl(env.ROOT_DOMAIN, slug), missingPhotos: await missingPhotos(env.MEDIA, env.ROOT_DOMAIN, documentJson), healed: false };
}

/**
 * The copy-and-point sequence of a LIVE site (copyLivePagesAgain, and restore's heal of an already-restored site), under
 * the lease: the live version's pages, verified, back to LIVE; the lease checked; the pointer written; then, as approve
 * does, a takedown re-read. A rejected put may still have landed (putRejected). A takedown by another admin can commit
 * after the lease ran out: the re-read throws or says the site is down or gone: the pointer is taken back out (not
 * lease-checked, as everywhere; logged ids-only if that fails) and the answer is live_copy_failed or site_taken_down.
 * A put that landed and rejected on a live site leaves the pointer in place (the site is live and it names its live
 * version): live_copy_failed, call it again.
 */
async function copyAndPoint(
  env: { DB: D1Database; LIVE: R2Bucket; WORK: R2Bucket },
  input: { siteId: string; slug: string; versionId: string; key: string; sha256: string; pagesJson: string; documentJson: string; token: string },
): Promise<void> {
  const { siteId, slug, versionId, key, sha256, pagesJson, documentJson, token } = input;
  const db = env.DB;
  const pages = await verifiedPages(env.WORK, { site_id: siteId, id: versionId, pages_json: pagesJson, html_key: key, html_sha256: sha256 });
  await copyLivePages(env.LIVE, slug, { siteId, versionId }, pages);
  await assertLease(db, siteId, token); // R2 cannot be conditioned on D1 (residual: see assertLease)
  let putRejected = false;
  try {
    await writeLivePointer(env.LIVE, slug, { siteId, versionId, ...liveMetadata(documentJson) });
  } catch {
    putRejected = true; // the write may still have landed: the read below decides, in both cases
  }
  let after: { taken_down_at: number | null } | null;
  try {
    after = await db.prepare("SELECT taken_down_at FROM sites WHERE id = ?").bind(siteId).first<{ taken_down_at: number | null }>();
  } catch {
    try {
      await env.LIVE.delete(livePointerKey(slug));
    } catch {
      console.error(JSON.stringify({ code: "pointer_unconfirmed", siteId, versionId }));
    }
    throw new PublishError("live_copy_failed", { versionId });
  }
  if (after === null || after.taken_down_at !== null) {
    try {
      await env.LIVE.delete(livePointerKey(slug));
    } catch {
      console.error(JSON.stringify({ code: "takedown_pointer_left", siteId, versionId }));
    }
    throw new PublishError("site_taken_down");
  }
  if (putRejected) throw new PublishError("live_copy_failed", { versionId });
  await removeOtherVersions(env.LIVE, db, slug, { siteId, versionId }, token);
}

/**
 * Plan 4's "Copy the live pages again", under the site's lease (A16-4c): copies every page of the live version,
 * verified, back to LIVE and rewrites the pointer, for a site that is live (a taken-down site is site_taken_down:
 * Plan 4 answers 409; this never touches taken_down_at). It changes no D1 state and writes no audit row (Plan 4
 * may record the admin action itself). A rejected pointer write is live_copy_failed: call it again. After the pointer
 * write it re-reads takedown (copyAndPoint): a site taken down meanwhile loses the pointer again.
 */
export async function copyLivePagesAgain(
  env: { DB: D1Database; LIVE: R2Bucket; WORK: R2Bucket; ROOT_DOMAIN: string },
  input: { siteId: string; reviewer: string; now: number },
): Promise<{ liveUrl: string }> {
  const { siteId, now } = input;
  const db = env.DB;
  const token = await acquireLease(db, siteId, now, "site_not_found");
  try {
    const site = await readLiveSite(db, siteId);
    if (site === null) throw new PublishError("site_not_found");
    const { slug, live_version_id: versionId, html_key: key, html_sha256: sha256, pages_json: pagesJson, document_json: documentJson } = site;
    if (site.taken_down_at !== null) throw new PublishError("site_taken_down");
    if (slug === null || versionId === null || key === null || sha256 === null || pagesJson === null || documentJson === null) throw new PublishError("not_live");

    await copyAndPoint(env, { siteId, slug, versionId, key, sha256, pagesJson, documentJson, token });
    return { liveUrl: siteUrl(env.ROOT_DOMAIN, slug) };
  } finally {
    await releaseLease(db, siteId, token);
  }
}

/** How many photos of the stored document are gone from MEDIA (a takedown with purgeMedia deletes them). */
async function missingPhotos(media: R2Bucket, root: string, documentJson: string): Promise<number> {
  const { facts } = JSON.parse(documentJson) as { facts: { heroPhoto?: { url: string }; photos?: Array<{ url: string }> } };
  const prefix = `https://media.${root}/`;
  const keys = [facts.heroPhoto, ...(facts.photos ?? [])].flatMap((photo) =>
    photo !== undefined && photo.url.startsWith(prefix) ? [photo.url.slice(prefix.length)] : [],
  );
  const found = await Promise.all(keys.map((key) => media.head(key)));
  return found.filter((object) => object === null).length;
}

/** The admin's search-engine switch. D1 only: the sites Worker reads sites.indexable on every cache miss. */
export async function setIndexable(
  env: { DB: D1Database },
  input: { siteId: string; reviewer: string; indexable: boolean; now: number },
): Promise<void> {
  const { siteId, reviewer, indexable, now } = input;
  const db = env.DB;
  const value = indexable ? 1 : 0;
  const results = await db.batch([
    db.prepare("UPDATE sites SET indexable = ?, updated_at = ? WHERE id = ? AND indexable <> ?").bind(value, now, siteId, value),
    auditIfChanged(db, { at: now, actor: `admin:${reviewer}`, action: "site.indexable_changed", siteId, detail: { indexable } }),
  ]);
  if (results[0]?.meta.changes === 0 && (await db.prepare("SELECT 1 AS found FROM sites WHERE id = ?").bind(siteId).first()) === null) {
    throw new PublishError("site_not_found");
  }
}
