import { AUDIT_ACTIONS, canonicalJson, livePageKey, livePointerKey, liveSitePrefix, newId, pagesDigest, versionPageKey, VersionPages } from "@asksite/core";
import { formatPhone } from "@asksite/renderer";
import type { PageId, SiteDocument } from "@asksite/site-schema";
import { PublishError, type PublishErrorCode } from "./errors.ts";

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const HTML_TYPE = "text/html; charset=utf-8";

/**
 * What the sites Worker's fixed pages say about the business, stored in the LIVE pointer's customMetadata
 * with siteId and versionId: the phone for its "Please call instead" pages (A15), the name for its
 * thank-you and 404 pages (QA-2 RU(2), RU(3)). The Worker reads them from the pointer's LIVE.head it makes, and
 * escapes them. Taken from the approved document's facts, so all are already public on the page: the name
 * as written, and the phone as the text the page shows and the E.164 number its tel: links call.
 * With the two ids the metadata stays under 400 bytes (a name is at most 60 UTF-16 units, so at
 * most 180 UTF-8 bytes), far under R2's 8,192 bytes for all custom metadata.
 */
export function liveMetadata(documentJson: string): { businessName: string; phoneText: string; phoneTel: string } {
  const { facts } = JSON.parse(documentJson) as SiteDocument;
  return { businessName: facts.businessName, phoneText: formatPhone(facts.phone), phoneTel: facts.phone };
}

/**
 * An audit row that is written only when the statement just before it in the same D1 batch
 * changed exactly one row (SQLite changes()), so a retried or refused action never logs twice.
 */
export function auditIfChanged(
  db: D1Database,
  entry: { at: number; actor: string; action: AuditAction; siteId: string; detail: Record<string, unknown> },
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?, ?, ?, ?, ? WHERE changes() = 1")
    .bind(entry.at, entry.actor, entry.action, entry.siteId, canonicalJson(entry.detail));
}

/**
 * A16-4c: one admin action per site at a time, as a lease on the sites row (admin_lock, admin_lock_until).
 * Assumption: no admin action runs longer than this (Workers' limits; the admin routes' runToEnd waits at most 30 s
 * after the response). An action that dies frees the site after this long, and a takedown may wait up to this long
 * behind a hung action (accepted: it answers site_busy, the admin retries).
 */
export const ADMIN_LEASE_MS = 120_000;

/**
 * Takes the site's lease and returns its token. `missing` is the action's own error for a site that does not exist
 * (approve: version_not_pending; the others: site_not_found). A site held by another action, whose lease has not run
 * out by `now`, is site_busy with the seconds to wait. Every D1 write of the action then carries the token.
 */
export async function acquireLease(db: D1Database, siteId: string, now: number, missing: PublishErrorCode): Promise<string> {
  const token = newId();
  const result = await db
    .prepare("UPDATE sites SET admin_lock = ?, admin_lock_until = ? WHERE id = ? AND (admin_lock IS NULL OR admin_lock_until < ?)")
    .bind(token, now + ADMIN_LEASE_MS, siteId, now)
    .run();
  if (result.meta.changes === 1) return token;
  const held = await db.prepare("SELECT admin_lock_until FROM sites WHERE id = ?").bind(siteId).first<{ admin_lock_until: number | null }>();
  if (held === null) throw new PublishError(missing);
  throw new PublishError("site_busy", { retryAfter: Math.max(1, Math.ceil(((held.admin_lock_until ?? now) - now) / 1000)) });
}

/** Frees the site, but only if this action's token still holds it (a lease another action took over is left alone). */
export async function releaseLease(db: D1Database, siteId: string, token: string): Promise<void> {
  try {
    await db.prepare("UPDATE sites SET admin_lock = NULL, admin_lock_until = NULL WHERE id = ? AND admin_lock = ?").bind(siteId, token).run();
  } catch {
    // Never masks the action's own result or error: the lease expires anyway.
    console.error(JSON.stringify({ code: "lease_release_failed", siteId }));
  }
}

/** The fence for a write to a table other than sites: true only while the token still holds the site. */
export const LEASE_HELD = "EXISTS (SELECT 1 FROM sites WHERE id = ? AND admin_lock = ?)";

/**
 * Throws site_busy (lease_lost) unless the token still holds the site. Called after a fenced write changed no row,
 * and right before every R2 pointer write or delete (R2 cannot be conditioned on D1). The take-back deletes
 * (approve's deletes after its takedown re-read, restore's pointerBack) are deliberately NOT lease-checked: they
 * remove a pointer from a site that must stay down, and a check there could leave the pointer on a taken-down site.
 * RESIDUAL: if the lease runs out between this check and the R2 call (only an action over ADMIN_LEASE_MS), that
 * R2 write can land after another action's. The D1 fence still keeps D1 right, and the sites Worker serves only
 * when the pointer's version equals D1's live version (a mismatch is a 503, never wrong bytes).
 */
export async function assertLease(db: D1Database, siteId: string, token: string): Promise<void> {
  const row = await db.prepare("SELECT admin_lock FROM sites WHERE id = ?").bind(siteId).first<{ admin_lock: string | null }>();
  if (row === null || row.admin_lock !== token) throw new PublishError("site_busy", { reason: "lease_lost" });
}

/** Lower-case hex SHA-256 of raw bytes (the stored page, exactly as R2 returns it). */
export async function sha256OfBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads a stored version and proves its bytes still hash to `expected`. */
export async function verifiedVersionBytes(work: R2Bucket, key: string, expected: string): Promise<ArrayBuffer | null> {
  const object = await work.get(key);
  if (object === null) return null;
  const bytes = await object.arrayBuffer();
  return (await sha256OfBytes(bytes)) === expected ? bytes : null;
}

export interface VerifiedPage {
  page: PageId;
  sha256: string;
  bytes: ArrayBuffer;
}

/**
 * The version's pages, each proved against the row: pages_json must parse as VersionPages, hash (as
 * pagesDigest) to the row's html_sha256, and start with the page html_key names (Home's WORK key); every
 * page's stored bytes must still hash to its own sha256. Anything else is an integrity refusal with a reason.
 */
export async function verifiedPages(
  work: R2Bucket,
  row: { site_id: string; id: string; pages_json: string; html_key: string; html_sha256: string },
): Promise<VerifiedPage[]> {
  let parsed: ReturnType<typeof VersionPages.safeParse>;
  try {
    parsed = VersionPages.safeParse(JSON.parse(row.pages_json));
  } catch {
    throw new PublishError("integrity", { reason: "pages_invalid" });
  }
  if (!parsed.success || versionPageKey(row.site_id, row.id, "home") !== row.html_key) throw new PublishError("integrity", { reason: "pages_invalid" });
  const pages = parsed.data;
  if ((await pagesDigest(pages)) !== row.html_sha256) throw new PublishError("integrity", { reason: "pages_digest_mismatch" });
  return Promise.all(
    pages.map(async ({ page, sha256 }) => {
      const bytes = await verifiedVersionBytes(work, versionPageKey(row.site_id, row.id, page), sha256);
      if (bytes === null) throw new PublishError("integrity", { reason: "stored_bytes_mismatch" });
      return { page, sha256, bytes };
    }),
  );
}

/**
 * Copies every verified page to its immutable LIVE key. Nothing is served from them until the pointer names the version.
 * RESIDUAL: pages of a version approve copied and that never became live (approve failed or was refused before its D1
 * batch made it live: lease_lost, site_taken_down, version_not_pending, an R2 error), and other versions' pages a stopped
 * cleanup left (live_cleanup_skipped), stay in LIVE unserved (the pointer never names them) until the next approval's or
 * restore's cleanup or a takedown removes them. Pages restore or copyLivePagesAgain copied before a refusal are the live
 * version's own: no cleanup removes them, and the next successful call serves them.
 */
export async function copyLivePages(live: R2Bucket, slug: string, ids: { siteId: string; versionId: string }, pages: readonly VerifiedPage[]): Promise<void> {
  await Promise.all(
    pages.map((p) =>
      live.put(livePageKey(slug, ids.versionId, p.page), p.bytes, {
        httpMetadata: { contentType: HTML_TYPE },
        customMetadata: { siteId: ids.siteId, versionId: ids.versionId, page: p.page, sha256: p.sha256 },
      }),
    ),
  );
}

/** The one write that switches the site to a version: an empty object whose metadata names it (and the business). */
export async function writeLivePointer(
  live: R2Bucket,
  slug: string,
  meta: { siteId: string; versionId: string; businessName: string; phoneText: string; phoneTel: string },
): Promise<void> {
  await live.put(livePointerKey(slug), "", { customMetadata: meta });
}

/**
 * Deletes every object under `prefix` that `keep` does not keep, a listing page at a time (R2 lists and deletes
 * at most 1,000 keys a call), and returns how many it deleted.
 */
export async function deletePrefix(
  bucket: R2Bucket,
  prefix: string,
  keep: (key: string) => boolean = () => false,
  proceed: () => Promise<boolean> = async () => true, // asked before each listing page's delete; false stops
): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await bucket.list(cursor === undefined ? { prefix } : { prefix, cursor });
    const doomed = page.objects.map((o) => o.key).filter((key) => !keep(key));
    if (doomed.length > 0) {
      if (!(await proceed())) break;
      await bucket.delete(doomed);
    }
    deleted += doomed.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return deleted;
}

/**
 * Deletes every LIVE page of the site that is not the kept version's. Best effort: the other versions are
 * unreferenced (the pointer names the kept one), so a failure leaves harmless orphans; it is logged (ids and a
 * code only) and never thrown, and the next approval or restore removes them. Before each listing page's delete D1
 * is read again: it goes on only while D1 still names the kept version as live and the action's lease is still
 * its own (otherwise it stops and logs live_cleanup_skipped: the live version's pages must never be deleted).
 */
export async function removeOtherVersions(
  live: R2Bucket,
  db: D1Database,
  slug: string,
  ids: { siteId: string; versionId: string },
  token: string,
): Promise<void> {
  const kept = `${liveSitePrefix(slug)}${ids.versionId}/`;
  let skipped = false;
  const stillOurs = async (): Promise<boolean> => {
    const row = await db.prepare("SELECT live_version_id, admin_lock FROM sites WHERE id = ?").bind(ids.siteId).first<{ live_version_id: string | null; admin_lock: string | null }>();
    skipped = row === null || row.live_version_id !== ids.versionId || row.admin_lock !== token;
    return !skipped;
  };
  try {
    await deletePrefix(live, liveSitePrefix(slug), (key) => key.startsWith(kept), stillOurs);
    if (skipped) console.error(JSON.stringify({ code: "live_cleanup_skipped", siteId: ids.siteId, versionId: ids.versionId }));
  } catch {
    console.error(JSON.stringify({ code: "live_cleanup_failed", siteId: ids.siteId, versionId: ids.versionId }));
  }
}
