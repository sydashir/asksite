import {
  canonicalJson,
  documentSha256,
  formActionUrl,
  LIMITS,
  newId,
  sha256Hex,
  toIssues,
  utcDayStart,
  versionKey,
  type OwnerEdits,
  type VersionSummary,
} from "@asksite/core";
import { render } from "@asksite/renderer";
import { SITE_CSS, SITE_CSS_SHA256 } from "@asksite/site-css";
import { SiteDocument } from "@asksite/site-schema";
import { PublishError } from "./errors.ts";
import { auditIfChanged, HTML_TYPE } from "./shared.ts";

const DAY_MS = 86_400_000;

/**
 * The owner's Publish: render the page, store the exact bytes in WORK, then (one D1 batch)
 * supersede any pending version, add this one as pending and point the site at it.
 * The batch only acts while the site is the owner's, still has this slug, is not taken down and has
 * fewer than LIMITS.publishRequestsPerSitePerDay requests today (Decision 25).
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

  // A cheap count first, so a request over the cap renders and stores nothing. The batch re-checks it.
  const dayStart = utcDayStart(now);
  const capReached = () => new PublishError("publish_cap_reached", { retryAfter: Math.ceil((dayStart + DAY_MS - now) / 1000) });
  if ((await requestsSince(db, siteId, dayStart)) >= LIMITS.publishRequestsPerSitePerDay) throw capReached();

  let html: string;
  try {
    html = render(document, { stylesheet: SITE_CSS, formAction: formActionUrl(env.ROOT_DOMAIN, slug, siteId) });
  } catch (error) {
    throw new PublishError("render_failed", [{ path: [], code: "render_failed", message: error instanceof Error ? error.message : "Render failed" }]);
  }

  const versionId = newId();
  const key = versionKey(siteId, versionId);
  const htmlSha256 = await sha256Hex(html);
  // Orphaned objects (a failed batch below) are harmless: nothing ever serves WORK publicly.
  await env.WORK.put(key, html, { httpMetadata: { contentType: HTML_TYPE }, customMetadata: { siteId, versionId, sha256: htmlSha256 } });

  const siteIsReady = "EXISTS (SELECT 1 FROM sites WHERE id = ? AND owner_id = ? AND slug = ? AND taken_down_at IS NULL)";
  const underCap = "(SELECT COUNT(*) FROM site_versions WHERE site_id = ? AND requested_at >= ?) < ?";
  const cap = LIMITS.publishRequestsPerSitePerDay;
  const results = await db.batch([
    db.prepare(`UPDATE site_versions SET status = 'superseded' WHERE site_id = ? AND status = 'pending' AND ${siteIsReady} AND ${underCap}`)
      .bind(siteId, siteId, ownerId, slug, siteId, dayStart, cap),
    db
      .prepare(
        `INSERT INTO site_versions (id, site_id, number, status, document_json, document_sha256, edits_json, generation_id,
           html_key, html_sha256, stylesheet_sha256, requested_by, requested_at)
         SELECT ?, ?, next.n, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM (SELECT COALESCE(MAX(number), 0) + 1 AS n FROM site_versions WHERE site_id = ?) AS next
         WHERE ${siteIsReady} AND ${underCap}
         RETURNING number`,
      )
      .bind(versionId, siteId, canonicalJson(document), await documentSha256(document), canonicalJson(edits), generationId,
        key, htmlSha256, SITE_CSS_SHA256, ownerId, now, siteId, siteId, ownerId, slug, siteId, dayStart, cap),
    // Only when the INSERT above happened (same transaction), so the site never points at a missing version.
    db.prepare("UPDATE sites SET pending_version_id = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM site_versions WHERE id = ? AND site_id = ?)")
      .bind(versionId, now, siteId, versionId, siteId),
    auditIfChanged(db, { at: now, actor: `owner:${ownerId}`, action: "version.requested", siteId, detail: { versionId } }),
  ]);

  const number = (results[1]?.results[0] as { number?: number } | undefined)?.number;
  if (number === undefined) {
    const site = await db.prepare("SELECT taken_down_at FROM sites WHERE id = ? AND owner_id = ?").bind(siteId, ownerId).first<{ taken_down_at: number | null }>();
    if (site !== null && site.taken_down_at !== null) throw new PublishError("site_taken_down");
    if ((await requestsSince(db, siteId, dayStart)) >= cap) throw capReached();
    throw new PublishError("integrity", { reason: "site_changed" });
  }
  return { id: versionId, number, status: "pending", requestedAt: now, reviewedAt: null, reviewNote: null };
}

/** Version requests of a site since `since` (every status counts: superseded and withdrawn ones used D1 too). */
async function requestsSince(db: D1Database, siteId: string, since: number): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM site_versions WHERE site_id = ? AND requested_at >= ?").bind(siteId, since).first<{ n: number }>();
  return row?.n ?? 0;
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
