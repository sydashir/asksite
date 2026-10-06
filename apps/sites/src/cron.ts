import { LIMITS } from "@asksite/core";

export type RetentionResult = {
  /** Spam leads (spam = 1) older than LIMITS.spamLeadRetentionDays. */
  spam: number;
  /** Leads of any kind still stored after that, older than LIMITS.leadRetentionDays. */
  expired: number;
  deleted: number;
  /** The database size in bytes after the deletions (D1's meta.size_after), when D1 reports it. */
  sizeAfter: number | undefined;
};

/**
 * Daily cleanup, two statements in this order: spam leads (spam = 1, which owners never see) after
 * LIMITS.spamLeadRetentionDays, then every lead after LIMITS.leadRetentionDays. Only spam = 1 rows
 * get the shorter period: pending, sent, failed and daily_cap leads are real and keep the full time.
 * Two statements give an exact count per rule.
 */
export async function deleteOldLeads(db: D1Database, now: number): Promise<RetentionResult> {
  const spamCutoff = now - LIMITS.spamLeadRetentionDays * 86_400_000;
  const cutoff = now - LIMITS.leadRetentionDays * 86_400_000;
  const spam = await db.prepare("DELETE FROM leads WHERE spam = 1 AND created_at < ?").bind(spamCutoff).run();
  const expired = await db.prepare("DELETE FROM leads WHERE created_at < ?").bind(cutoff).run();
  return { spam: spam.meta.changes, expired: expired.meta.changes, deleted: spam.meta.changes + expired.meta.changes, sizeAfter: expired.meta.size_after };
}
