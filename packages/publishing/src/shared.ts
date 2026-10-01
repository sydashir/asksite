import { AUDIT_ACTIONS, canonicalJson, livePageKey, livePointerKey, liveSitePrefix, pagesDigest, versionPageKey, VersionPages } from "@asksite/core";
import { formatPhone } from "@asksite/renderer";
import type { PageId, SiteDocument } from "@asksite/site-schema";
import { PublishError } from "./errors.ts";

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

/** Copies every verified page to its immutable LIVE key. Nothing is served from them until the pointer names the version. */
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
export async function deletePrefix(bucket: R2Bucket, prefix: string, keep: (key: string) => boolean = () => false): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await bucket.list(cursor === undefined ? { prefix } : { prefix, cursor });
    const doomed = page.objects.map((o) => o.key).filter((key) => !keep(key));
    if (doomed.length > 0) await bucket.delete(doomed);
    deleted += doomed.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return deleted;
}

/**
 * Deletes every LIVE page of the site that is not the kept version's. Best effort: the other versions are
 * unreferenced (the pointer names the kept one), so a failure leaves harmless orphans; it is logged (ids and a
 * code only) and never thrown, and the next approval or restore removes them.
 */
export async function removeOtherVersions(live: R2Bucket, slug: string, ids: { siteId: string; versionId: string }): Promise<void> {
  const kept = `${liveSitePrefix(slug)}${ids.versionId}/`;
  try {
    await deletePrefix(live, liveSitePrefix(slug), (key) => key.startsWith(kept));
  } catch {
    console.error(JSON.stringify({ code: "live_cleanup_failed", siteId: ids.siteId, versionId: ids.versionId }));
  }
}
