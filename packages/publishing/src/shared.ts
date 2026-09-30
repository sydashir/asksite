import { AUDIT_ACTIONS, canonicalJson } from "@asksite/core";
import { formatPhone } from "@asksite/renderer";
import type { SiteDocument } from "@asksite/site-schema";

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const HTML_TYPE = "text/html; charset=utf-8";

/**
 * What the sites Worker's fixed pages say about the business, stored in the LIVE object's customMetadata
 * with siteId, versionId and sha256: the phone for its "Please call instead" pages (A15), the name for its
 * thank-you and 404 pages (QA-2 RU(2), RU(3)). The Worker reads them from the LIVE.head it makes, and
 * escapes them. Taken from the approved document's facts, so all are already public on the page: the name
 * as written, and the phone as the text the page shows and the E.164 number its tel: links call.
 * With the ids and the hash the metadata stays under 400 bytes (a name is at most 60 UTF-16 units, so at
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
