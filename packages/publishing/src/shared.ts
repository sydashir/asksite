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
 * With the three ids (siteId, versionId and the writer: each a 36-character UUID) the metadata stays under 400 bytes
 * (measured at most 364: 50 of keys and 314 of values, a name being at most 60 UTF-16 units, so at most 180 UTF-8
 * bytes), far under R2's 8,192 bytes for all custom metadata.
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
 * (approve's deletes after its takedown re-read, restore's pointerBack, and copyAndPoint's, used by copyLivePagesAgain
 * and restore's heal; all takeBackPointer) are deliberately NOT lease-checked: they
 * remove a pointer from a site D1 says is down (or whose state cannot be read), and a check there could leave the pointer
 * on a taken-down site. A take-back removes its own write (the pointer's "writer" is the action's writeId) and, only while
 * this action holds the lease on a site D1 shows down (holdsDownSite), any pointer; with the lease lost, the site gone or
 * D1 unreadable, another action's pointer is left alone. Restore's take-backs ask D1 first and leave the pointer of a site that is live.
 * RESIDUAL: if the lease runs out between this check and the R2 call (only an action over ADMIN_LEASE_MS), that
 * R2 write can land after another action's. The D1 fence still keeps D1 right. On a cache miss the sites Worker
 * serves only when D1 says the site is live and not taken down and the pointer's version equals D1's live version
 * (a mismatch is a 503, never wrong bytes); a page already in the edge cache under the pointer's version is served
 * with no D1 check, for up to its 60 s s-maxage (apps/sites/src/page.ts), so a late pointer write on a taken-down site
 * is served from the cache for that long. The pointer's business name is also shown, with no D1 read, on the site's
 * not-found pages (a missing page, an unknown path) and the form's thank-you page, and its phone on the form's
 * rate-limit page (apps/sites/src/page.ts, router.ts, form.ts).
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
 * batch made it live: lease_lost, site_taken_down, version_not_pending, an R2 error) are deleted again, best effort, by
 * removeUnservedCopy; when that cannot (logged approve_copy_left), and other versions' pages a stopped cleanup left
 * (live_cleanup_skipped), they stay in LIVE unserved (the pointer never names them) until the next approval's or
 * restore's cleanup, a takedown or the owner's account deletion removes them. Pages restore or copyLivePagesAgain copied before a refusal are the live
 * version's own: no cleanup removes them, and the next successful call serves them.
 */
export async function copyLivePages(live: R2Bucket, slug: string, ids: { siteId: string; versionId: string }, pages: readonly VerifiedPage[]): Promise<void> {
  // Every put settles before this returns or throws (the first failure is thrown): a put still in flight could land
  // after approve's cleanup of a failed copy (removeUnservedCopy) and leave an object behind.
  const settled = await Promise.allSettled(
    pages.map((p) =>
      live.put(livePageKey(slug, ids.versionId, p.page), p.bytes, {
        httpMetadata: { contentType: HTML_TYPE },
        customMetadata: { siteId: ids.siteId, versionId: ids.versionId, page: p.page, sha256: p.sha256 },
      }),
    ),
  );
  for (const result of settled) if (result.status === "rejected") throw result.reason;
}

/**
 * Approve's failure path: deletes the pages this approve copied to LIVE (the exact keys, at most 5, no listing) when it
 * failed before its batch made the version live, so a later slug change cannot leave them stored under the old slug.
 * Only while D1 still shows this action's lease and a live version other than this one: a batch that committed and then
 * threw, or an accepted retry, leaves the version live in D1, and "Approve again" writes its pointer; another action
 * may own those keys once the lease is lost. A site row that is gone does not stop the delete (the owner's account was
 * deleted meanwhile: nothing else would remove them). When the copies are LEFT (D1 unreadable, the lease lost, the
 * delete failed) it logs ids only (approve_copy_left). Never throws: approve rethrows its own error.
 */
export async function removeUnservedCopy(
  live: R2Bucket,
  db: D1Database,
  slug: string,
  ids: { siteId: string; versionId: string },
  token: string,
  pages: readonly PageId[],
): Promise<void> {
  try {
    const row = await db.prepare("SELECT live_version_id, admin_lock FROM sites WHERE id = ?").bind(ids.siteId).first<{ live_version_id: string | null; admin_lock: string | null }>();
    if (row !== null) {
      if (row.admin_lock !== token) throw new Error("copies left");
      if (row.live_version_id === ids.versionId) return; // live in D1: the copies are its pages
    }
    // A site row that is gone (an owner deletion finished while this approve outlived its lease) leaves nobody to clean
    // up later: these exact keys name this version id, which no other site can own, so they are deleted (never a prefix).
    await live.delete(pages.map((page) => livePageKey(slug, ids.versionId, page)));
  } catch {
    console.error(JSON.stringify({ code: "approve_copy_left", siteId: ids.siteId, versionId: ids.versionId }));
  }
}

/**
 * The one write that switches the site to a version: an empty object whose metadata names it (and the business) and the
 * writing action's `writeId` as "writer" (a random id of that one call, never the lease token, which stays in D1). The
 * sites Worker ignores the writer; takeBackPointer reads it.
 */
export async function writeLivePointer(
  live: R2Bucket,
  slug: string,
  meta: { siteId: string; versionId: string; businessName: string; phoneText: string; phoneTel: string },
  writeId: string,
): Promise<void> {
  await live.put(livePointerKey(slug), "", { customMetadata: { ...meta, writer: writeId } });
}

/** What the take-back's one D1 re-read of the site returns (null: the site is gone, or the read threw). */
export interface TakeBackRow {
  taken_down_at: number | null;
  admin_lock: string | null;
}

/**
 * True only when the re-read shows BOTH that the site is down (the row is there and taken_down_at is set) and that this
 * action's own lease token still holds it. acquireLease writes a NEW token on every takeover, so a matching token proves
 * no other action took the site over since this one did: whatever pointer is there now is stale or this action's own,
 * and a down site must not keep it. No expiry check is needed for the same reason. The one place this is decided: every
 * take-back caller passes holdsDownSite of the row it re-read; where that re-read threw there is no row, so the caller
 * passes false, the same answer holdsDownSite(null, token) gives (no lease can be shown without a row).
 */
export function holdsDownSite(row: TakeBackRow | null, token: string): boolean {
  return row !== null && row.taken_down_at !== null && row.admin_lock === token;
}

/**
 * The one take-back of a pointer, for every action that wrote one (approve's, copyAndPoint's, restore's; named
 * takeBackPointer now that it can remove a pointer that is not the action's own). The CALLER asks D1 first (one SELECT of
 * taken_down_at and admin_lock) and calls this only when D1 says the site is down or gone, or cannot be read; a live site
 * keeps its pointer. `anyPointer` is holdsDownSite(row, token): then the pointer is deleted whoever wrote it (a stale
 * pointer an earlier failed action left on this down site, whose own take-back delete failed, must not stay: the
 * business name would show on the host's 404s). Otherwise the rule is: delete the pointer only when its `writer` is this
 * action's `writeId`. A pointer another action wrote (an action that outlived its lease finds the site down because another
 * restore has written its pointer and not yet cleared taken_down_at, and the lease is lost) is left alone, with no log; a
 * missing pointer needs no delete. If the HEAD itself throws, the pointer is deleted: takedown safety first, a pointer
 * must not stay on a site that may be down (the cost, if it was another action's, is the residual below). A failed delete
 * is logged (ids and `code` only), never thrown. Not lease-checked, as every take-back: a check could leave a pointer on a
 * taken-down site.
 * RESIDUAL: R2's delete takes no condition (developers.cloudflare.com/r2/api/workers/workers-api-reference/:
 * `delete(key: string | string[]): Promise<void>`, no options; only get() and put() accept onlyIf), so between this
 * HEAD and the delete another action can write its pointer and this delete removes it. That needs this action to have
 * outlived its lease and the other write to land in that gap, or another action's late put to land there while THIS action
 * holds a valid lease (that case removes a late pointer from a down site: it errs on the safe side); the site then has no
 * pointer until Restore or Copy the live pages again writes it (`healed: true`). Also, with `anyPointer`: a takeover, its
 * full page copy and its pointer put all landing between the caller's re-read and the delete (then this delete removes the
 * new holder's pointer: the site is live with no pointer until Restore again / Copy the live pages again heals it).
 * RULED RESIDUAL (moderator, 2026-10-05): a stale pointer from an earlier failed take-back stays on a down site when this action's re-read throws or its lease is lost; the host's 404 may show the business name until Take down again (logged takedown_pointer_left).
 */
export async function takeBackPointer(
  live: R2Bucket,
  slug: string,
  writeId: string,
  anyPointer: boolean,
  failed: { code: "pointer_unconfirmed" | "takedown_pointer_left"; siteId: string; versionId: string },
): Promise<void> {
  try {
    let ours = true; // a HEAD that throws: delete (see above)
    try {
      const pointer = await live.head(livePointerKey(slug));
      if (pointer === null) return;
      ours = anyPointer || pointer.customMetadata?.["writer"] === writeId;
    } catch {
      // unknown whose it is
    }
    if (ours) await live.delete(livePointerKey(slug));
  } catch {
    console.error(JSON.stringify({ code: failed.code, siteId: failed.siteId, versionId: failed.versionId }));
  }
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
