// SQL text the admin routes share. No Cloudflare types here, so the Node test program can import it and check it.

/**
 * The sites (s) and owners (o) columns toAdminSiteRow reads (facts_json only for the business name). A list reads
 * only these; brief_json is read only where one site is opened (SITE_WITH_OWNER). Moderator ruling, 2026-09-30.
 */
export const ADMIN_SITE_COLUMNS = `s.id, s.owner_id, s.slug, s.facts_json, s.live_version_id, s.pending_version_id,
  s.indexable, s.taken_down_at, s.created_at, s.updated_at, o.email AS owner_email, o.disabled_at AS owner_disabled_at`;

/**
 * The review queue (§3.2 step 3): versions waiting for review, oldest first, the id breaking a tie so the order is
 * the same on every load, at most 50, with only the columns the queue shows (moderator ruling, 2026-09-30).
 */
export const REVIEW_QUEUE = `SELECT v.id AS v_id, v.number AS v_number, v.status AS v_status, v.requested_at AS v_requested_at,
    v.reviewed_at AS v_reviewed_at, v.review_note AS v_review_note, ${ADMIN_SITE_COLUMNS}
  FROM site_versions v JOIN sites s ON s.id = v.site_id JOIN owners o ON o.id = s.owner_id
  WHERE v.status = 'pending' ORDER BY v.requested_at, v.id LIMIT 50`;

/** The sites list (§3.2 step 4): only the columns toAdminSiteRow reads, no brief_json, newest change first, the id breaking a tie. */
export const SITE_LIST = `SELECT ${ADMIN_SITE_COLUMNS} FROM sites s JOIN owners o ON o.id = s.owner_id`;
export const SITE_LIST_TAIL = "ORDER BY s.updated_at DESC, s.id LIMIT 500";

/** A site's version history: only the columns VersionSummary shows (never document_json or edits_json), newest first, at most 50. */
export const VERSION_HISTORY = `SELECT id, number, status, requested_at, reviewed_at, review_note FROM site_versions WHERE site_id = ? ORDER BY number DESC LIMIT 50`;

/**
 * A site's generations, newest first, at most 50. GenerationRow's two big columns are not read: they come back as
 * placeholders so the row still has GenerationRow's shape for toGenerationView, which reads neither (plan3-generation
 * packages/generation/src/view.ts).
 */
export const GENERATION_HISTORY = `SELECT id, site_id, owner_id, kind, status, '' AS input_json, NULL AS output_json, used_fallback, fallback_reason, model_slot,
    provider, model, attempts, input_tokens, output_tokens, cost_microusd, error_code, created_at, started_at, finished_at
  FROM generations WHERE site_id = ? ORDER BY created_at DESC, id LIMIT 50`;

/** A site's audit trail: newest first, at most 100. */
export const SITE_AUDIT = "SELECT at, actor, action, detail_json FROM audit_log WHERE site_id = ? ORDER BY at DESC, id DESC LIMIT 100";
