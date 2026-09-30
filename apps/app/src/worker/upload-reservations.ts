import { LIMITS } from "@asksite/core";

// P4-21: an upload's row is reserved before its billed Images transform runs, and counts toward both upload caps from
// then on (uploads.reserved_at, migration 0003). A reservation ends as a photo (finishPhoto) or as a counted failure
// (markFailed), is released after a failure that is ours (release), or, left behind by a request that died, is aged
// out into a counted failure (ageOutSiteReservations, ageOutReservations). No statement here uses RETURNING (A10).

/**
 * A reservation older than this was left by a request that died (DECIDED P4-21: 10 minutes). After a disconnect,
 * "waitUntil() can extend execution for up to 30 seconds" (developers.cloudflare.com/workers/platform/limits/).
 */
export const RESERVATION_STALE_MS = 10 * 60_000;

/** A photo's measured size: what a reservation is finished with. */
export interface PhotoSize {
  width: number;
  height: number;
  bytes: number;
}

/**
 * Reserves the upload's row (no size yet, not deleted) under the exact caps: the row is created only while the site's
 * kept uploads are under 40 and all its uploads under 150, reservations included. False when the caps refused it.
 */
export async function reserve(db: D1Database, id: string, siteId: string, now: number): Promise<boolean> {
  const reserved = await db
    .prepare(
      `INSERT INTO uploads (id, site_id, width, height, bytes, created_at, reserved_at)
       SELECT ?1, ?2, 0, 0, 0, ?3, ?3
       WHERE (SELECT COUNT(*) FROM uploads WHERE site_id = ?2 AND deleted_at IS NULL) < ?4
         AND (SELECT COUNT(*) FROM uploads WHERE site_id = ?2) < ?5`,
    )
    .bind(id, siteId, now, LIMITS.uploadsPerSite, LIMITS.uploadsPerSiteTotal)
    .run();
  return reserved.meta.changes === 1;
}

/**
 * Finishes the reservation as a kept photo of this size. False when it was lost meanwhile: aged out (the request
 * outlived RESERVATION_STALE_MS) or marked deleted by a takedown's purge. It then stays a counted failure.
 */
export async function finishPhoto(db: D1Database, id: string, size: PhotoSize): Promise<boolean> {
  const finished = await db
    .prepare("UPDATE uploads SET width = ?2, height = ?3, bytes = ?4, reserved_at = NULL WHERE id = ?1 AND reserved_at IS NOT NULL AND deleted_at IS NULL")
    .bind(id, size.width, size.height, size.bytes)
    .run();
  return finished.meta.changes === 1;
}

/**
 * Marks the reservation a counted failure (P4-14's shape: no size, deleted): it keeps counting toward the 150 total,
 * frees its kept slot, and is never shown. A deletion time a takedown's purge already set is kept.
 */
export async function markFailed(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare("UPDATE uploads SET deleted_at = COALESCE(deleted_at, ?2), reserved_at = NULL WHERE id = ?1 AND reserved_at IS NOT NULL").bind(id, now).run();
}

/** Deletes the reservation after a failure that is ours (an Images service error, a MEDIA outage): P4-14's rule. */
export async function release(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM uploads WHERE id = ?1 AND reserved_at IS NOT NULL").bind(id).run();
}

/** Ages out the site's stale reservations into counted failures (at its next upload's pre-check), alone or in a batch. */
export function ageOutSiteReservations(db: D1Database, siteId: string, now: number): D1PreparedStatement {
  return db
    .prepare("UPDATE uploads SET deleted_at = COALESCE(deleted_at, ?2), reserved_at = NULL WHERE site_id = ?1 AND reserved_at IS NOT NULL AND reserved_at < ?2 - ?3")
    .bind(siteId, now, RESERVATION_STALE_MS);
}

/** Ages out every site's stale reservations into counted failures: the daily cleanup's backstop, alone or in a batch. */
export function ageOutReservations(db: D1Database, now: number): D1PreparedStatement {
  return db
    .prepare("UPDATE uploads SET deleted_at = COALESCE(deleted_at, ?1), reserved_at = NULL WHERE reserved_at IS NOT NULL AND reserved_at < ?1 - ?2")
    .bind(now, RESERVATION_STALE_MS);
}
