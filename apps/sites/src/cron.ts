import { LIMITS } from "@asksite/core";

// The sites Worker's two Cron Triggers (wrangler.jsonc triggers.crons). Both call the same scheduled() handler, which
// tells them apart by controller.cron, "the value of the Cron Trigger that started the ScheduledEvent"
// (developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/). Cron Triggers run on UTC.
/** Daily lead retention (deleteOldLeads). */
export const RETENTION_CRON = "0 7 * * *";
/** The lead-email retry (retryLeadEmails, C1). */
export const RETRY_CRON = "*/15 * * * *";

export type RetentionResult = {
  /** Spam leads (spam = 1) aged between LIMITS.spamLeadRetentionDays and LIMITS.leadRetentionDays (older ones count as expired). */
  spam: number;
  /** Every lead, spam included, older than LIMITS.leadRetentionDays. */
  expired: number;
  deleted: number;
  /** The database size in bytes after both deletions (D1's meta.size_after of the last statement), when D1 reports it. */
  sizeAfter: number | undefined;
};

/**
 * Daily cleanup, two statements in this order: every lead after LIMITS.leadRetentionDays (the published
 * promise, so it never waits on the other statement), then spam leads (spam = 1, which owners never see)
 * after LIMITS.spamLeadRetentionDays. Only spam = 1 rows get the shorter period: pending, sent, failed and
 * daily_cap leads are real and keep the full time. Two statements give an exact count per rule.
 */
export async function deleteOldLeads(db: D1Database, now: number): Promise<RetentionResult> {
  const cutoff = now - LIMITS.leadRetentionDays * 86_400_000;
  const spamCutoff = now - LIMITS.spamLeadRetentionDays * 86_400_000;
  const expired = await db.prepare("DELETE FROM leads WHERE created_at < ?").bind(cutoff).run();
  const spam = await db.prepare("DELETE FROM leads WHERE spam = 1 AND created_at < ?").bind(spamCutoff).run();
  return { spam: spam.meta.changes, expired: expired.meta.changes, deleted: spam.meta.changes + expired.meta.changes, sizeAfter: spam.meta.size_after };
}
