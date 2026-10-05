// The site-state statements of Plan 2B (packages/publishing/src/site-state.ts, shared.ts) that the app's test seams
// copy, because apps/app has no LIVE binding (the real functions need one). Every seam uses these
// constants, and test/worker/plan2b-statements.test.ts pins each one to its file byte for byte. The takedown note
// is no copy: the seams bind the real TAKEDOWN_REVIEW_NOTE that @asksite/publishing exports.
// A16-4c: every admin action runs under the site's lease (admin_lock), so the seams take it with underLease below.

/** shared.ts LEASE_HELD: the fence for a write to a table other than sites (the statements below embed it as ${LEASE_HELD}). */
export const LEASE_HELD_SQL = "EXISTS (SELECT 1 FROM sites WHERE id = ? AND admin_lock = ?)";

/** shared.ts acquireLease's statement: binds token, lease end, site id, now. */
export const ACQUIRE_LEASE_SQL = "UPDATE sites SET admin_lock = ?, admin_lock_until = ? WHERE id = ? AND (admin_lock IS NULL OR admin_lock_until < ?)";

/** shared.ts releaseLease's statement: binds site id, token. */
export const RELEASE_LEASE_SQL = "UPDATE sites SET admin_lock = NULL, admin_lock_until = NULL WHERE id = ? AND admin_lock = ?";

/** takeDown's site statement (site-state.ts): binds taken_down_at, reason, updated_at, site id, token. */
export const TAKE_DOWN_SITE_SQL = "UPDATE sites SET taken_down_at = ?, takedown_reason = ?, pending_version_id = NULL, updated_at = ? WHERE id = ? AND taken_down_at IS NULL AND admin_lock = ?";

/** takeDown's media purge statement (site-state.ts, with LEASE_HELD expanded): binds deleted_at, site id, site id, token. */
export const PURGE_UPLOADS_SQL = `UPDATE uploads SET deleted_at = ? WHERE site_id = ? AND deleted_at IS NULL AND ${LEASE_HELD_SQL}`;

/** restore's clearing statement (site-state.ts): binds updated_at, site id, expected taken_down_at, live version id, token. */
export const RESTORE_SITE_SQL = "UPDATE sites SET taken_down_at = NULL, takedown_reason = NULL, updated_at = ? WHERE id = ? AND taken_down_at = ? AND live_version_id = ? AND admin_lock = ?";

/** takeDown's versions statement (site-state.ts, with LEASE_HELD expanded): every pending version becomes rejected; binds reviewer, reviewed_at, TAKEDOWN_REVIEW_NOTE, site id, site id, token. */
export const TAKE_DOWN_VERSIONS_SQL = `UPDATE site_versions SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE site_id = ? AND status = 'pending' AND ${LEASE_HELD_SQL}`;

/** The slice of D1Database underLease uses (the test program has no Workers types; a D1Database satisfies it). */
type LeaseDb = { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<{ meta: { changes: number } }>; first<R>(): Promise<R | null> } } };

/** Runs `action` under the site's lease as the admin actions do (acquireLease, the action's writes carrying the token, releaseLease). */
export async function underLease<T>(db: LeaseDb, siteId: string, action: (token: string) => Promise<T>): Promise<T> {
  const token = crypto.randomUUID();
  const now = Date.now();
  const taken = await db.prepare(ACQUIRE_LEASE_SQL).bind(token, now + 120_000, siteId, now).run();
  if (taken.meta.changes !== 1) throw new Error(`the test seam could not take the lease of site ${siteId}`);
  try {
    return await action(token);
  } finally {
    await db.prepare(RELEASE_LEASE_SQL).bind(siteId, token).run();
  }
}

/**
 * What the admin's Restore does to the site row: the clearing statement, fenced on the taken_down_at the admin saw, the
 * live version and the lease. Real restore answers not_live for a site with no live version, so a test site that was
 * never published is given one here (no foreign key; the seams have no pages to copy). Returns the rows it changed.
 */
export async function restoreSite(db: LeaseDb, siteId: string): Promise<number> {
  await db.prepare("UPDATE sites SET live_version_id = ? WHERE id = ? AND live_version_id IS NULL").bind("test-live-version", siteId).run();
  const site = await db.prepare("SELECT taken_down_at, live_version_id FROM sites WHERE id = ?").bind(siteId).first<{ taken_down_at: number | null; live_version_id: string | null }>();
  const cleared = await underLease(db, siteId, (token) =>
    db.prepare(RESTORE_SITE_SQL).bind(Date.now(), siteId, site?.taken_down_at ?? null, site?.live_version_id ?? null, token).run(),
  );
  return cleared.meta.changes;
}
