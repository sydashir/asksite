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

/** What reserving found: the row reserved, the site taken down (decision 39), or the caps full. */
export type Reservation = "reserved" | "taken_down" | "full";

/** The read of whether the site is taken down, alone or in a batch. */
function takenDownQuery(db: D1Database, siteId: string): D1PreparedStatement {
  return db.prepare("SELECT taken_down_at FROM sites WHERE id = ?").bind(siteId);
}

/**
 * Reserves the upload's row (no size yet, not deleted) under the exact caps, for a site that is up: the row is created
 * only while the site is not taken down (decision 39), its kept uploads are under 40 and all its uploads under 150,
 * reservations included. Otherwise it says why: "taken_down" when the site is taken down, else "full".
 */
export async function reserve(db: D1Database, id: string, siteId: string, now: number): Promise<Reservation> {
  // One batch, so the read sees the state the INSERT saw: "Batched statements are SQL transactions", and "each
  // statement in the list will execute and commit, sequentially, non-concurrently" (developers.cloudflare.com/d1/worker-api/d1-database/).
  const [reserved, site] = await db.batch<{ taken_down_at: number | null }>([
    db
      .prepare(
        `INSERT INTO uploads (id, site_id, width, height, bytes, created_at, reserved_at)
         SELECT ?1, ?2, 0, 0, 0, ?3, ?3
         WHERE (SELECT COUNT(*) FROM uploads WHERE site_id = ?2 AND deleted_at IS NULL) < ?4
           AND (SELECT COUNT(*) FROM uploads WHERE site_id = ?2) < ?5
           AND EXISTS (SELECT 1 FROM sites WHERE id = ?2 AND taken_down_at IS NULL)`,
      )
      .bind(id, siteId, now, LIMITS.uploadsPerSite, LIMITS.uploadsPerSiteTotal),
    takenDownQuery(db, siteId),
  ]);
  if (reserved?.meta.changes === 1) return "reserved";
  return (site?.results[0]?.taken_down_at ?? null) !== null ? "taken_down" : "full";
}

/**
 * Finishes the reservation as a kept photo of this size, while its own site is up. False when it was lost meanwhile:
 * aged out (the request outlived RESERVATION_STALE_MS) or marked deleted by a takedown's purge; or when its site was
 * taken down meanwhile (decision 39).
 */
export async function finishPhoto(db: D1Database, id: string, size: PhotoSize): Promise<boolean> {
  const finished = await db
    .prepare(
      `UPDATE uploads SET width = ?2, height = ?3, bytes = ?4, reserved_at = NULL WHERE id = ?1 AND reserved_at IS NOT NULL AND deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM sites WHERE sites.id = uploads.site_id AND taken_down_at IS NULL)`,
    )
    .bind(id, size.width, size.height, size.bytes)
    .run();
  return finished.meta.changes === 1;
}

/** Whether the site is taken down now: the one read after a reservation was lost, to answer as a takedown does. */
export async function isTakenDown(db: D1Database, siteId: string): Promise<boolean> {
  const site = await takenDownQuery(db, siteId).first<{ taken_down_at: number | null }>();
  return site !== null && site.taken_down_at !== null;
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

/**
 * The age-out, written once for both uses below: reservations older than RESERVATION_STALE_MS become counted failures
 * (markFailed's shape; a purge's deletion time is kept). Binds ?1 now and ?2 RESERVATION_STALE_MS.
 */
const AGE_OUT_STALE_RESERVATIONS =
  "UPDATE uploads SET deleted_at = COALESCE(deleted_at, ?1), reserved_at = NULL WHERE reserved_at IS NOT NULL AND reserved_at < ?1 - ?2";

/** Ages out the site's stale reservations into counted failures (at its next upload's pre-check), alone or in a batch. */
export function ageOutSiteReservations(db: D1Database, siteId: string, now: number): D1PreparedStatement {
  return db.prepare(`${AGE_OUT_STALE_RESERVATIONS} AND site_id = ?3`).bind(now, RESERVATION_STALE_MS, siteId);
}

/** Ages out every site's stale reservations into counted failures: the daily cleanup's backstop, alone or in a batch. */
export function ageOutReservations(db: D1Database, now: number): D1PreparedStatement {
  return db.prepare(AGE_OUT_STALE_RESERVATIONS).bind(now, RESERVATION_STALE_MS);
}
