import type { AUDIT_ACTIONS } from "@asksite/core";

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Just the part of a SQL binding (D1) that building one statement needs; keeps this package binding-free. */
export interface SqlDatabase<Statement> {
  prepare(query: string): { bind(...values: unknown[]): Statement };
}

/** One audit_log row (§2.6). actor is "admin:<email>", "owner:<id>" or "system". */
export function auditStatement<Statement>(
  db: SqlDatabase<Statement>,
  entry: { at: number; actor: string; action: AuditAction; siteId: string | null; detail?: Record<string, unknown> },
): Statement {
  return db
    .prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (?, ?, ?, ?, ?)")
    .bind(entry.at, entry.actor, entry.action, entry.siteId, entry.detail === undefined ? null : JSON.stringify(entry.detail));
}
