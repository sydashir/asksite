import { AUDIT_ACTIONS, canonicalJson } from "@asksite/core";
import { formatPhone } from "@asksite/renderer";
import type { SiteDocument } from "@asksite/site-schema";

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const HTML_TYPE = "text/html; charset=utf-8";

/**
 * The business phone that goes into the LIVE object's customMetadata with siteId, versionId and sha256
 * (A15): the sites Worker prints it on its "Please call instead" page from the LIVE.head it already makes.
 * Taken from the approved document's facts, so it is already public on the page: the text the page shows
 * and the E.164 number its tel: links call.
 */
export function livePhoneMetadata(documentJson: string): { phoneText: string; phoneTel: string } {
  const { facts } = JSON.parse(documentJson) as SiteDocument;
  return { phoneText: formatPhone(facts.phone), phoneTel: facts.phone };
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
