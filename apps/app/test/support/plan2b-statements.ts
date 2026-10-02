// The site-state statements of Plan 2B (packages/publishing/src/site-state.ts) that the app's test seams
// copy, because apps/app has no LIVE binding (the real functions need one). Every seam uses these
// constants, and test/worker/plan2b-statements.test.ts pins each one to that file byte for byte. The takedown note
// is no copy: the seams bind the real TAKEDOWN_REVIEW_NOTE that @asksite/publishing exports.

/** takeDown's site statement (site-state.ts). */
export const TAKE_DOWN_SITE_SQL = "UPDATE sites SET taken_down_at = ?, takedown_reason = ?, pending_version_id = NULL, updated_at = ? WHERE id = ? AND taken_down_at IS NULL";

/** takeDown's media purge statement (site-state.ts). */
export const PURGE_UPLOADS_SQL = "UPDATE uploads SET deleted_at = ? WHERE site_id = ? AND deleted_at IS NULL";

/** restore's site statement (site-state.ts). */
export const RESTORE_SITE_SQL = "UPDATE sites SET taken_down_at = NULL, takedown_reason = NULL, updated_at = ? WHERE id = ? AND taken_down_at IS NOT NULL";

/** takeDown's versions statement: every pending version becomes rejected, with TAKEDOWN_REVIEW_NOTE bound as the third value. */
export const TAKE_DOWN_VERSIONS_SQL = "UPDATE site_versions SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE site_id = ? AND status = 'pending'";
