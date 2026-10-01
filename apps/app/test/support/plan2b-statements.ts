import { TAKEDOWN_REVIEW_NOTE } from "../../src/client/lib/takedown-note.ts";

// The site-state statements of Plan 2B (packages/publishing/src/site-state.ts) that the app's test seams
// copy, because apps/app has no LIVE binding and no @asksite/publishing dependency. Every seam uses these
// constants, and test/worker/plan2b-statements.test.ts pins each one to that file byte for byte.

/** takeDown's site statement (site-state.ts:25). */
export const TAKE_DOWN_SITE_SQL = "UPDATE sites SET taken_down_at = ?, takedown_reason = ?, pending_version_id = NULL, updated_at = ? WHERE id = ? AND taken_down_at IS NULL";

/** takeDown's media purge statement (site-state.ts:33). */
export const PURGE_UPLOADS_SQL = "UPDATE uploads SET deleted_at = ? WHERE site_id = ? AND deleted_at IS NULL";

/** restore's site statement (site-state.ts:94). */
export const RESTORE_SITE_SQL = "UPDATE sites SET taken_down_at = NULL, takedown_reason = NULL, updated_at = ? WHERE id = ? AND taken_down_at IS NOT NULL";

/** takeDown's versions statement (site-state.ts:23): every pending version becomes rejected with the takedown note. */
export const TAKE_DOWN_VERSIONS_SQL = `UPDATE site_versions SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = '${TAKEDOWN_REVIEW_NOTE}' WHERE site_id = ? AND status = 'pending'`;
