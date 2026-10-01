import {
  canonicalJson,
  documentSha256,
  formActionUrl,
  hashPages,
  LIMITS,
  newId,
  pagesDigest,
  siteUrl,
  toIssues,
  utcDayStart,
  versionKey,
  versionPageKey,
  VersionPages,
  type OwnerEdits,
  type VersionSummary,
} from "@asksite/core";
import { render, type RenderedSite } from "@asksite/renderer";
import { DESIGN_CSS } from "@asksite/site-css";
import { SiteDocument } from "@asksite/site-schema";
import { PublishError } from "./errors.ts";
import { auditIfChanged, HTML_TYPE } from "./shared.ts";

const DAY_MS = 86_400_000;

const siteChanged = () => new PublishError("integrity", { reason: "site_changed" });

/**
 * The owner's Publish. Cheap checks come first (the site is the owner's, not taken down, under today's
 * LIMITS.publishRequestsPerSitePerDay (Decision 25), still has this slug, and the generation is this site's),
 * so a request they refuse renders and stores nothing. Then: render the site, store each page's exact bytes
 * in WORK, and (one D1 batch) supersede any pending version, add this one as pending (its pages, their digest
 * and Home's WORK key in the same row) and point the site at it.
 * The batch re-checks the owner, slug, takedown and cap, for a request that races another one or a change
 * made in the meantime. If the batch refuses, the stored pages are deleted again (only when no version row
 * names them) and the refusal is explained.
 */
export async function createPendingVersion(
  env: { DB: D1Database; WORK: R2Bucket; ROOT_DOMAIN: string },
  input: { siteId: string; ownerId: string; slug: string; document: SiteDocument; edits: OwnerEdits; generationId: string | null; now: number },
): Promise<VersionSummary> {
  const { siteId, ownerId, slug, edits, generationId, now } = input;
  const db = env.DB;

  // Store the parsed form (trimmed, NFKC, defaults), whatever the caller passed; re-parsing a parsed
  // document is a no-op, so document_sha256 matches documentSha256 of the parsed draft.
  const parsed = SiteDocument.safeParse(input.document);
  if (!parsed.success) throw new PublishError("render_failed", toIssues(parsed.error));
  const document = parsed.data;

  // Cheap checks first, so a request that would be refused renders and stores nothing. The batch re-checks
  // the site and the cap, for a request that races another one or a change made in the meantime.
  const refused = await refusal(db, input);
  if (refused !== null) throw refused;

  // The site in the document's own design, with that design's stylesheet; render() reports the sheet's
  // SHA-256, which the version records (A12).
  let site: RenderedSite;
  try {
    site = render(document, { stylesheets: DESIGN_CSS, formAction: formActionUrl(env.ROOT_DOMAIN, slug, siteId), siteUrl: siteUrl(env.ROOT_DOMAIN, slug) });
  } catch (error) {
    throw new PublishError("render_failed", [{ path: [], code: "render_failed", message: error instanceof Error ? error.message : "Render failed" }]);
  }
  const rendered = await hashPages(site.pages);
  // The renderer's pages are always a valid list; if they are not, that is our bug, not the owner's.
  const listed = VersionPages.safeParse(rendered.map(({ page, sha256 }) => ({ page, sha256 })));
  if (!listed.success) throw new PublishError("render_failed", [{ path: [], code: "render_failed", message: "The renderer returned an invalid list of pages" }]);
  const pages = listed.data;
  const digest = await pagesDigest(pages);

  const versionId = newId();
  const key = versionKey(siteId, versionId);
  const keys = rendered.map((p) => versionPageKey(siteId, versionId, p.page));
  // Pages the batch below refuses are deleted again. If D1 itself fails, whether the batch committed is
  // unknown, so the pages stay; an orphan is harmless, as nothing ever serves WORK publicly.
  await Promise.all(
    rendered.map((p, i) =>
      env.WORK.put(keys[i] ?? key, p.html, { httpMetadata: { contentType: HTML_TYPE }, customMetadata: { siteId, versionId, page: p.page, sha256: p.sha256 } }),
    ),
  );

  const dayStart = utcDayStart(now);
  const siteIsReady = "EXISTS (SELECT 1 FROM sites WHERE id = ? AND owner_id = ? AND slug = ? AND taken_down_at IS NULL)";
  const underCap = "(SELECT COUNT(*) FROM site_versions WHERE site_id = ? AND requested_at >= ?) < ?";
  const cap = LIMITS.publishRequestsPerSitePerDay;
  const results = await db.batch([
    db.prepare(`UPDATE site_versions SET status = 'superseded' WHERE site_id = ? AND status = 'pending' AND ${siteIsReady} AND ${underCap}`)
      .bind(siteId, siteId, ownerId, slug, siteId, dayStart, cap),
    db
      .prepare(
        `INSERT INTO site_versions (id, site_id, number, status, document_json, document_sha256, edits_json, generation_id,
           pages_json, html_key, html_sha256, stylesheet_sha256, requested_by, requested_at)
         SELECT ?, ?, next.n, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM (SELECT COALESCE(MAX(number), 0) + 1 AS n FROM site_versions WHERE site_id = ?) AS next
         WHERE ${siteIsReady} AND ${underCap}`,
      )
      .bind(versionId, siteId, canonicalJson(document), await documentSha256(document), canonicalJson(edits), generationId,
        canonicalJson(pages), key, digest, site.stylesheetSha256, ownerId, now, siteId, siteId, ownerId, slug, siteId, dayStart, cap),
    // The number, read in the same transaction. Not RETURNING: production D1 returns no rows for writes (A10).
    db.prepare("SELECT number FROM site_versions WHERE id = ?").bind(versionId),
    // Only when the INSERT above happened (same transaction), so the site never points at a missing version.
    db.prepare("UPDATE sites SET pending_version_id = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM site_versions WHERE id = ? AND site_id = ?)")
      .bind(versionId, now, siteId, versionId, siteId),
    auditIfChanged(db, { at: now, actor: `owner:${ownerId}`, action: "version.requested", siteId, detail: { versionId } }),
  ]);

  const number = (results[2]?.results[0] as { number?: number } | undefined)?.number;
  if (number === undefined) {
    // No row: the INSERT did not happen, and no version can ever point at these pages. Delete them, then find out why.
    // That a read later in the batch sees the INSERT is inferred for production D1 (A10), so the pages are deleted
    // only when no version row names them; a row without a number is logged (IDs and a code only).
    const stored = await db.prepare("SELECT 1 FROM site_versions WHERE id = ?").bind(versionId).first();
    if (stored === null) await deleteRefusedPages(env.WORK, keys, { siteId, versionId });
    else console.error(JSON.stringify({ code: "version_number_missing", siteId, versionId }));
    throw (await refusal(db, input)) ?? siteChanged();
  }
  return { id: versionId, number, status: "pending", requestedAt: now, reviewedAt: null, reviewNote: null };
}

/**
 * Why a request would be refused right now, or null. Ownership is checked first, so another owner learns
 * nothing about the site: not that it is taken down, nor that it is at its cap.
 */
async function refusal(
  db: D1Database,
  input: { siteId: string; ownerId: string; slug: string; generationId: string | null; now: number },
): Promise<PublishError | null> {
  const { siteId, ownerId, slug, generationId, now } = input;
  const dayStart = utcDayStart(now);
  // Today's requests: every status counts (superseded, withdrawn and reviewed ones used D1 and R2 too).
  const site = await db
    .prepare(
      `SELECT slug, taken_down_at,
         (SELECT COUNT(*) FROM site_versions WHERE site_id = sites.id AND requested_at >= ?) AS requests,
         (SELECT COUNT(*) FROM generations WHERE id = ? AND site_id = ?) AS generations
       FROM sites WHERE id = ? AND owner_id = ?`,
    )
    .bind(dayStart, generationId, siteId, siteId, ownerId)
    .first<{ slug: string | null; taken_down_at: number | null; requests: number; generations: number }>();
  if (site === null) return siteChanged();
  if (site.taken_down_at !== null) return new PublishError("site_taken_down");
  if (site.requests >= LIMITS.publishRequestsPerSitePerDay) {
    return new PublishError("publish_cap_reached", { retryAfter: Math.ceil((dayStart + DAY_MS - now) / 1000) });
  }
  if (site.slug !== slug) return siteChanged();
  // The generation must be this site's own: an unknown id would fail the batch with a raw FOREIGN KEY error
  // (site_versions.generation_id references generations(id)), and another site's is not this version's provenance.
  if (generationId !== null && site.generations === 0) return new PublishError("integrity", { reason: "generation_not_found" });
  return null;
}

/** Best effort, one call for all the pages: a failed delete leaves orphans (harmless), logged with IDs and a code only. */
async function deleteRefusedPages(work: R2Bucket, keys: string[], ids: { siteId: string; versionId: string }): Promise<void> {
  try {
    await work.delete(keys);
  } catch {
    console.error(JSON.stringify({ code: "refused_page_not_deleted", ...ids }));
  }
}

/** The owner's Withdraw: the pending version becomes "withdrawn" and the site has nothing in review. */
export async function withdrawPending(env: { DB: D1Database }, input: { siteId: string; ownerId: string; now: number }): Promise<void> {
  const { siteId, ownerId, now } = input;
  const db = env.DB;
  const site = await db.prepare("SELECT pending_version_id FROM sites WHERE id = ? AND owner_id = ?").bind(siteId, ownerId).first<{ pending_version_id: string | null }>();
  const versionId = site?.pending_version_id ?? null;
  if (versionId === null) throw new PublishError("nothing_pending");

  const results = await db.batch([
    db.prepare("UPDATE sites SET pending_version_id = NULL, updated_at = ? WHERE id = ? AND owner_id = ? AND pending_version_id = ?").bind(now, siteId, ownerId, versionId),
    auditIfChanged(db, { at: now, actor: `owner:${ownerId}`, action: "version.withdrawn", siteId, detail: { versionId } }),
    db.prepare("UPDATE site_versions SET status = 'withdrawn' WHERE id = ? AND status = 'pending'").bind(versionId),
  ]);
  if (results[0]?.meta.changes !== 1) throw new PublishError("nothing_pending");
}
