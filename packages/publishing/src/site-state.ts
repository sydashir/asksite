import { canonicalJson, livePointerKey, liveSitePrefix, siteUrl } from "@asksite/core";
import { PublishError } from "./errors.ts";
import { type AuditAction, auditIfChanged, copyLivePages, deletePrefix, liveMetadata, removeOtherVersions, verifiedPages, writeLivePointer } from "./shared.ts";

/**
 * The admin's Take down, in this order:
 * 1) the site's LIVE pointer is deleted first: it stops every page at once, cached ones included (a cached page's
 *    key names its version, and the Worker reads the pointer before it looks at the cache). If that fails the
 *    takedown fails with nothing changed in D1, and the admin retries;
 * 2) the D1 batch, which also stops the pages and photos being served (the sites Worker checks D1 on a cache miss);
 * 3) every LIVE page of the site is deleted, and 4) MEDIA is purged, both as defence in depth, and both are
 *    retried by calling takeDown again (it is idempotent).
 * Only the first call writes the takedown row. A later call whose purge deletes anything (an object,
 * or an upload not yet marked deleted) writes its own row, so no deletion goes unlogged (design §4.5).
 */
export async function takeDown(
  env: { DB: D1Database; LIVE: R2Bucket; MEDIA: R2Bucket },
  input: { siteId: string; reviewer: string; reason: string; purgeMedia: boolean; now: number },
): Promise<void> {
  const { siteId, reviewer, reason, purgeMedia, now } = input;
  const db = env.DB;
  const site = await db.prepare("SELECT slug FROM sites WHERE id = ?").bind(siteId).first<{ slug: string | null }>();
  if (site === null) throw new PublishError("site_not_found");

  if (site.slug !== null) await env.LIVE.delete(livePointerKey(site.slug));

  const actor = `admin:${reviewer}`;
  const [, takenDown] = await db.batch([
    db.prepare("UPDATE site_versions SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = 'Site taken down' WHERE site_id = ? AND status = 'pending'")
      .bind(reviewer, now, siteId),
    db.prepare("UPDATE sites SET taken_down_at = ?, takedown_reason = ?, pending_version_id = NULL, updated_at = ? WHERE id = ? AND taken_down_at IS NULL")
      .bind(now, reason, now, siteId),
    auditIfChanged(db, { at: now, actor, action: "site.taken_down", siteId, detail: { reason, purgeMedia } }),
  ]);

  if (site.slug !== null) await deletePrefix(env.LIVE, liveSitePrefix(site.slug));
  if (purgeMedia) {
    const deletedObjects = await deletePrefix(env.MEDIA, `${siteId}/`);
    const markDeleted = db.prepare("UPDATE uploads SET deleted_at = ? WHERE site_id = ? AND deleted_at IS NULL").bind(now, siteId);
    // This call's takedown row (written only when it took the site down) already records the purge.
    const firstCall = takenDown?.meta.changes === 1;
    await db.batch(firstCall ? [markDeleted] : [markDeleted, auditLaterPurge(db, { at: now, actor, siteId, reason }, deletedObjects)]);
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
 * The admin's Restore. Copies every page of the live version, verified, back to LIVE and writes the pointer (not
 * served yet: D1 still says taken down), then clears taken_down_at. Retry-safe. On a live site that is not taken
 * down it changes no D1 row and writes no audit row: it copies the live pages again and rewrites the pointer.
 * Takes ROOT_DOMAIN (not in the design's signature) because it returns the live URL, and MEDIA to
 * count the page's photos a purge deleted (Decision 29): the page still goes back up.
 */
export async function restore(
  env: { DB: D1Database; LIVE: R2Bucket; WORK: R2Bucket; MEDIA: R2Bucket; ROOT_DOMAIN: string },
  input: { siteId: string; reviewer: string; now: number },
): Promise<{ liveUrl: string; missingPhotos: number }> {
  const { siteId, reviewer, now } = input;
  const db = env.DB;
  const site = await db
    .prepare("SELECT s.slug, s.live_version_id, v.html_key, v.html_sha256, v.pages_json, v.document_json FROM sites s LEFT JOIN site_versions v ON v.id = s.live_version_id WHERE s.id = ?")
    .bind(siteId)
    .first<{ slug: string | null; live_version_id: string | null; html_key: string | null; html_sha256: string | null; pages_json: string | null; document_json: string | null }>();
  if (site === null) throw new PublishError("site_not_found");
  const { slug, live_version_id: versionId, html_key: key, html_sha256: sha256, pages_json: pagesJson, document_json: documentJson } = site;
  if (slug === null || versionId === null || key === null || sha256 === null || pagesJson === null || documentJson === null) throw new PublishError("not_live");

  const pages = await verifiedPages(env.WORK, { site_id: siteId, id: versionId, pages_json: pagesJson, html_key: key, html_sha256: sha256 });
  await copyLivePages(env.LIVE, slug, { siteId, versionId }, pages);
  await writeLivePointer(env.LIVE, slug, { siteId, versionId, ...liveMetadata(documentJson) });

  await db.batch([
    db.prepare("UPDATE sites SET taken_down_at = NULL, takedown_reason = NULL, updated_at = ? WHERE id = ? AND taken_down_at IS NOT NULL").bind(now, siteId),
    auditIfChanged(db, { at: now, actor: `admin:${reviewer}`, action: "site.restored", siteId, detail: { versionId } }),
  ]);
  await removeOtherVersions(env.LIVE, slug, { siteId, versionId });
  return { liveUrl: siteUrl(env.ROOT_DOMAIN, slug), missingPhotos: await missingPhotos(env.MEDIA, env.ROOT_DOMAIN, documentJson) };
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
