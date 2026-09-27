import { ApiError, DRAFT_JSON_MAX_BYTES, readJson } from "@asksite/app-common";
import { LIMITS, PatchDraftBody, type SiteRow, type UploadRow } from "@asksite/core";
import { Hono } from "hono";
import { foundSite, ownedSite, ownedSiteQuery } from "../db.ts";
import type { AppDeps } from "../deps.ts";
import { requireOwner } from "../session.ts";
import { buildSiteView, currentAiQuery, draftIssues, draftOf, liveUploadsQuery, toCurrentAi, type CurrentAiRow } from "../site-view.ts";
import type { AppEnv } from "../types.ts";

const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

/** GET /api/sites/:siteId and PATCH /api/sites/:siteId/draft (§2.5, §4.4). */
export function siteRoutes(deps: AppDeps): Hono<AppEnv> {
  const sites = new Hono<AppEnv>();

  sites.get("/sites/:siteId", requireOwner, async (c) => {
    const site = await ownedSite(c.env.DB, c.req.param("siteId"), c.get("owner").id);
    return c.json(await buildSiteView(c.env, deps, site, Date.now()));
  });

  sites.patch("/sites/:siteId/draft", requireOwner, async (c) => {
    const owner = c.get("owner");
    const siteId = c.req.param("siteId");
    // The one body that carries whole parts: it is read with the draft limit (§4.1, A8c), which never
    // refuses a draft whose parts fit their own limits below.
    const body = await readJson(c, PatchDraftBody, DRAFT_JSON_MAX_BYTES);
    const facts = body.facts === undefined ? null : JSON.stringify(body.facts);
    const brief = body.brief === undefined ? null : JSON.stringify(body.brief);
    const edits = body.edits === undefined ? null : JSON.stringify(body.edits);
    if (
      (facts !== null && byteLength(facts) > LIMITS.factsJsonMaxBytes) ||
      (brief !== null && byteLength(brief) > LIMITS.briefJsonMaxBytes) ||
      (edits !== null && byteLength(edits) > LIMITS.editsJsonMaxBytes)
    ) {
      throw new ApiError("payload_too_large", "That is more text than a website can hold. Please shorten it.");
    }
    const db = c.env.DB;
    // One conditional write: the rev check makes a stale tab fail instead of overwriting newer work. What the
    // answer reports is read in the same batch (one transaction, A10), so it is this save's rev and issues even
    // when another save lands right after it.
    const [write, siteRead, aiRead, uploadsRead] = await db.batch([
      db
        .prepare(
          `UPDATE sites SET facts_json = COALESCE(?1, facts_json), brief_json = COALESCE(?2, brief_json),
             edits_json = COALESCE(?3, edits_json), rev = rev + 1, updated_at = ?4
           WHERE id = ?5 AND owner_id = ?6 AND rev = ?7 AND taken_down_at IS NULL`,
        )
        .bind(facts, brief, edits, Date.now(), siteId, owner.id, body.rev),
      ownedSiteQuery(db, siteId, owner.id),
      currentAiQuery(db, siteId),
      liveUploadsQuery(db, siteId),
    ]);
    const site = foundSite(siteRead?.results[0] as SiteRow | undefined);
    if (write?.meta.changes !== 1) {
      if (site.taken_down_at !== null) throw new ApiError("site_taken_down", "This website has been taken offline. Contact us to restore it.");
      throw new ApiError("conflict", "This site changed in another tab or window", { currentRev: site.rev });
    }
    const current = toCurrentAi(aiRead?.results[0] as CurrentAiRow | undefined);
    const uploads = (uploadsRead?.results ?? []) as UploadRow[];
    return c.json({ rev: site.rev, issues: draftIssues(draftOf(site), current?.ai ?? null, site.id, c.env.ROOT_DOMAIN, uploads) });
  });

  return sites;
}
