import { logLine } from "@asksite/app-common";
import { ageOutReservations } from "./upload-reservations.ts";

const DAY_MS = 86_400_000;

/**
 * Daily cleanup (§5.2). Login tokens are kept for a day after they are created, not just until
 * they expire, so the "10 per owner per day" cap still counts them. Upload reservations a request
 * that died left behind become counted failures once 10 minutes old: the backstop for a site that
 * never uploads again, whose next upload would otherwise do it (P4-21).
 */
export async function cleanup(db: D1Database, now: number): Promise<void> {
  const [sessions, tokens, reservations] = await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM login_tokens WHERE created_at <= ?").bind(now - DAY_MS),
    ageOutReservations(db, now),
  ]);
  logLine({
    event: "cleanup",
    sessions: sessions?.meta.changes ?? 0,
    loginTokens: tokens?.meta.changes ?? 0,
    staleUploads: reservations?.meta.changes ?? 0,
  });
}
