import { logLine } from "@asksite/app-common";

const DAY_MS = 86_400_000;

/**
 * Daily cleanup (§5.2). Login tokens are kept for a day after they are created, not just until
 * they expire, so the "10 per owner per day" cap still counts them.
 */
export async function cleanup(db: D1Database, now: number): Promise<void> {
  const [sessions, tokens] = await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM login_tokens WHERE created_at <= ?").bind(now - DAY_MS),
  ]);
  logLine({ event: "cleanup", sessions: sessions?.meta.changes ?? 0, loginTokens: tokens?.meta.changes ?? 0 });
}
