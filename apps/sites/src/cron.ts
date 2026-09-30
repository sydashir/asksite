import { LIMITS } from "@asksite/core";

/** Daily cleanup: deletes leads older than LIMITS.leadRetentionDays. Returns how many were deleted. */
export async function deleteOldLeads(db: D1Database, now: number): Promise<number> {
  const cutoff = now - LIMITS.leadRetentionDays * 86_400_000;
  const result = await db.prepare("DELETE FROM leads WHERE created_at < ?").bind(cutoff).run();
  return result.meta.changes;
}
