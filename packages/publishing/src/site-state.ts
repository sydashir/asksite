import { liveKey, siteUrl } from "@asksite/core";
import { PublishError } from "./errors.ts";
import { auditIfChanged, HTML_TYPE, verifiedVersionBytes } from "./shared.ts";

/**
 * The admin's Take down. The D1 batch alone stops the page and its photos being served (the sites
 * Worker checks D1 on every cache miss). Deleting LIVE and purging MEDIA come after, as defence in
 * depth, and are retried by calling takeDown again (it is idempotent).
 */
export async function takeDown(
  env: { DB: D1Database; LIVE: R2Bucket; MEDIA: R2Bucket },
  input: { siteId: string; reviewer: string; reason: string; purgeMedia: boolean; now: number },
): Promise<void> {
  const { siteId, reviewer, reason, purgeMedia, now } = input;
  const db = env.DB;
  const site = await db.prepare("SELECT slug FROM sites WHERE id = ?").bind(siteId).first<{ slug: string | null }>();
  if (site === null) throw new PublishError("site_not_found");

  await db.batch([
    db.prepare("UPDATE site_versions SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = 'Site taken down' WHERE site_id = ? AND status = 'pending'")
      .bind(reviewer, now, siteId),
    db.prepare("UPDATE sites SET taken_down_at = ?, takedown_reason = ?, pending_version_id = NULL, updated_at = ? WHERE id = ? AND taken_down_at IS NULL")
      .bind(now, reason, now, siteId),
    auditIfChanged(db, { at: now, actor: `admin:${reviewer}`, action: "site.taken_down", siteId, detail: { reason, purgeMedia } }),
  ]);

  if (site.slug !== null) await env.LIVE.delete(liveKey(site.slug));
  if (purgeMedia) {
    await deletePrefix(env.MEDIA, `${siteId}/`);
    await db.prepare("UPDATE uploads SET deleted_at = ? WHERE site_id = ? AND deleted_at IS NULL").bind(now, siteId).run();
  }
}

async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list(cursor === undefined ? { prefix } : { prefix, cursor });
    if (page.objects.length > 0) await bucket.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
}

/**
 * The admin's Restore. Copies the live version's verified bytes back to LIVE first (not served yet:
 * D1 still says taken down), then clears taken_down_at. Retry-safe.
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
    .prepare("SELECT s.slug, s.live_version_id, v.html_key, v.html_sha256, v.document_json FROM sites s LEFT JOIN site_versions v ON v.id = s.live_version_id WHERE s.id = ?")
    .bind(siteId)
    .first<{ slug: string | null; live_version_id: string | null; html_key: string | null; html_sha256: string | null; document_json: string | null }>();
  if (site === null) throw new PublishError("site_not_found");
  const { slug, live_version_id: versionId, html_key: key, html_sha256: sha256, document_json: documentJson } = site;
  if (slug === null || versionId === null || key === null || sha256 === null || documentJson === null) throw new PublishError("not_live");

  const bytes = await verifiedVersionBytes(env.WORK, key, sha256);
  if (bytes === null) throw new PublishError("integrity", { reason: "stored_bytes_mismatch" });
  await env.LIVE.put(liveKey(slug), bytes, { httpMetadata: { contentType: HTML_TYPE }, customMetadata: { siteId, versionId, sha256 } });

  await db.batch([
    db.prepare("UPDATE sites SET taken_down_at = NULL, takedown_reason = NULL, updated_at = ? WHERE id = ? AND taken_down_at IS NOT NULL").bind(now, siteId),
    auditIfChanged(db, { at: now, actor: `admin:${reviewer}`, action: "site.restored", siteId, detail: { versionId } }),
  ]);
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
