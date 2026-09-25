import { AUDIT_ACTIONS, canonicalJson } from "@asksite/core";

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const HTML_TYPE = "text/html; charset=utf-8";

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
