import type { SiteRow, SiteSummary } from "@asksite/core";
import { Hono } from "hono";
import { requireOwner } from "../session.ts";
import type { AppEnv } from "../types.ts";

/** What /api/me reads of a site: only what its summary shows. The site's facts, brief and edits never leave D1. */
type SummaryRow = Pick<SiteRow, "id" | "slug" | "live_version_id" | "pending_version_id" | "taken_down_at"> & { business_name: string | null };

/**
 * The business name, read from facts_json inside D1. NULL unless the column is valid JSON and the name is text,
 * as a draft may hold anything (§2.5): json_extract throws on malformed JSON, and gives an object or a list as its
 * JSON text (sqlite.org/json1.html); a CASE is evaluated lazily, left to right (sqlite.org/lang_expr.html).
 */
const BUSINESS_NAME = `CASE
    WHEN NOT json_valid(facts_json) THEN NULL
    WHEN json_type(facts_json, '$.businessName') = 'text' THEN json_extract(facts_json, '$.businessName')
  END`;

function summary(site: SummaryRow): SiteSummary {
  return {
    id: site.id,
    slug: site.slug,
    businessName: site.business_name !== null && site.business_name.trim() !== "" ? site.business_name : null,
    live: site.live_version_id !== null && site.taken_down_at === null,
    inReview: site.pending_version_id !== null,
    takenDown: site.taken_down_at !== null,
  };
}

/** GET /api/me: the signed-in owner and their sites (§4.4). */
export function meRoutes(): Hono<AppEnv> {
  const me = new Hono<AppEnv>();
  me.get("/me", requireOwner, async (c) => {
    const owner = c.get("owner");
    const { results } = await c.env.DB.prepare(
      `SELECT id, slug, live_version_id, pending_version_id, taken_down_at, ${BUSINESS_NAME} AS business_name
       FROM sites WHERE owner_id = ? ORDER BY created_at`,
    )
      .bind(owner.id)
      .all<SummaryRow>();
    return c.json({ owner, sites: results.map(summary) });
  });
  return me;
}
