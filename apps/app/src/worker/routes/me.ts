import { readJson } from "@asksite/app-common";
import { SetPasswordBody, type SiteRow, type SiteSummary } from "@asksite/core";
import { Hono } from "hono";
import { passwordState, setPassword } from "../password.ts";
import { requireOwner } from "../session.ts";
import type { AppEnv } from "../types.ts";

/** What /api/me reads of a site: only what its summary shows. The site's facts, brief and edits never leave D1. */
type SummaryRow = Pick<SiteRow, "id" | "slug" | "live_version_id" | "pending_version_id" | "taken_down_at"> & { business_name: string | null };

/**
 * Facts' limit on a business name (site-schema facts.ts: text(2, 60)). Zod counts a string's length in Unicode code
 * points (zod.dev/api), as SQLite's substr does (sqlite.org/lang_corefunc.html#substr).
 */
const BUSINESS_NAME_MAX = 60;

/**
 * The business name, read from facts_json inside D1 and cut there to BUSINESS_NAME_MAX, so a draft's name of any
 * length never reaches the Worker whole (P4-21). NULL unless the column is valid JSON and the name is text, as a draft
 * may hold anything (§2.5): json_extract throws on malformed JSON, and gives an object or a list as its JSON text
 * (sqlite.org/json1.html); a CASE is evaluated lazily, left to right (sqlite.org/lang_expr.html).
 */
const BUSINESS_NAME = `CASE
    WHEN NOT json_valid(facts_json) THEN NULL
    WHEN json_type(facts_json, '$.businessName') = 'text' THEN substr(json_extract(facts_json, '$.businessName'), 1, ${BUSINESS_NAME_MAX})
  END`;

/**
 * The name cut to BUSINESS_NAME_MAX code points again, so the answer never exceeds Facts' limit, counted as Facts
 * counts (DECIDED P4-21 8). D1 already cut it to that many, but a lone surrogate (only a hand-made request can store
 * one, as a JSON escape) is one character there and reaches the Worker as three U+FFFD. Array.from splits a string
 * into code points, a lone surrogate counting as one, as it does for Zod.
 */
const withinFactsLimit = (name: string): string => Array.from(name).slice(0, BUSINESS_NAME_MAX).join("");

function summary(site: SummaryRow): SiteSummary {
  return {
    id: site.id,
    slug: site.slug,
    businessName: site.business_name !== null && site.business_name.trim() !== "" ? withinFactsLimit(site.business_name) : null,
    live: site.live_version_id !== null && site.taken_down_at === null,
    inReview: site.pending_version_id !== null,
    takenDown: site.taken_down_at !== null,
  };
}

/** GET /api/me: the signed-in owner, their sites (§4.4), whether they have a password and whether this session may set one without it. */
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
    const password = await passwordState(c.env.DB, c.get("sessionHash"), Date.now());
    return c.json({ owner, sites: results.map(summary), ...password });
  });

  /** Sets the first password or replaces it (password.ts setPassword); 200 { hasPassword: true } when stored. */
  me.post("/me/password", requireOwner, async (c) => {
    const body = await readJson(c, SetPasswordBody);
    await setPassword(c.env, c.get("owner"), c.get("sessionHash"), body, Date.now());
    return c.json({ hasPassword: true });
  });
  return me;
}
