import { ApiError, DRAFT_JSON_MAX_BYTES, readJson } from "@asksite/app-common";
import { LIMITS, PatchDraftBody, type SiteRow, type UploadRow } from "@asksite/core";
import { Hono } from "hono";
import { foundSite, ownedSite, ownedSiteQuery } from "../db.ts";
import type { AppDeps } from "../deps.ts";
import { requireOwner } from "../session.ts";
import { buildSiteView, currentAiQuery, draftIssues, draftOf, liveUploadsQuery, toCurrentAi, type CurrentAiRow } from "../site-view.ts";
import type { AppEnv } from "../types.ts";
import { storedJsonNote } from "./stored-json-note.ts";

const byteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

/** GET /api/sites/:siteId and PATCH /api/sites/:siteId/draft (§2.5, §4.4). */
export function siteRoutes(deps: AppDeps): Hono<AppEnv> {
  const sites = new Hono<AppEnv>();

  sites.get("/sites/:siteId", requireOwner, async (c) => {
    const site = await ownedSite(c.env.DB, c.req.param("siteId"), c.get("owner").id);
    return c.json(await buildSiteView(c.env, deps, site, Date.now(), storedJsonNote(c)));
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
    // Copy and order edits apply only on the generation they were built on (compose ignores them on any other), so
    // a save that carries them is bound to the newest one; hidden and look edits carry over and are never bound.
    const wordingBound = body.edits !== undefined && (Object.keys(body.edits.copy).length > 0 || body.edits.order !== null);
    const db = c.env.DB;
    // One conditional write: the rev check makes a stale tab fail instead of overwriting newer work. What the
    // answer reports is read in the same batch (one transaction, A10), so it is this save's rev and issues even
    // when another save lands right after it. Edits whose theme is null never replace a stored theme (A12 §3):
    // the look pinned before a rebuild stays, even when a tab that still holds no theme saves its edits. The stored
    // edits are read only once json_valid passed them, inside a CASE: sqlite.org/lang_expr.html documents CASE as
    // lazy, but not the order AND evaluates its operands in (P4-21 item 6).
    // The two guards after the rev are the last tests of the same WHERE: a refused save stores nothing, not even its facts. While a
    // REGENERATE is queued or running a save that CARRIES EDITS (copy, order, look or hidden: body.edits present) is not stored: a save replaces
    // the stored edits whole, so even a look or hide save would carry the owner's wording, and the new wording replaces the draft anyway.
    // A save that carries only answers (facts and/or brief) is stored as normal: answers are not edits, a finished rewrite writes only the
    // generation's output (never sites.rev) and the rewrite works from its own snapshot, so an answer typed meanwhile is never lost.
    // Otherwise a wording or order save must be bound to the newest succeeded generation. IS (not =) so a site with no AI yet (no
    // succeeded generation) accepts edits bound to null, as an empty draft does.
    const [write, siteRead, aiRead, uploadsRead, rewriteRead] = await db.batch([
      db
        .prepare(
          `UPDATE sites SET facts_json = COALESCE(?1, facts_json), brief_json = COALESCE(?2, brief_json),
             edits_json = CASE WHEN ?3 IS NULL THEN edits_json
               WHEN json_extract(?3,'$.theme') IS NULL
                 AND CASE WHEN json_valid(edits_json) THEN json_type(edits_json,'$.theme')='object' ELSE 0 END
                 THEN json_set(?3,'$.theme', json(json_extract(edits_json,'$.theme')))
               ELSE ?3 END,
             rev = rev + 1, updated_at = ?4
           WHERE id = ?5 AND owner_id = ?6 AND rev = ?7 AND taken_down_at IS NULL
             AND (?3 IS NULL OR NOT EXISTS (SELECT 1 FROM generations WHERE site_id = ?5 AND kind = 'regenerate' AND status IN ('queued', 'running')))
             AND (?8 = 0 OR ?9 IS (SELECT id FROM generations WHERE site_id = ?5 AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1))`,
        )
        .bind(facts, brief, edits, Date.now(), siteId, owner.id, body.rev, wordingBound ? 1 : 0, body.edits?.baseGenerationId ?? null),
      ownedSiteQuery(db, siteId, owner.id),
      currentAiQuery(db, siteId),
      liveUploadsQuery(db, siteId),
      db.prepare("SELECT 1 AS rewriting FROM generations WHERE site_id = ? AND kind = 'regenerate' AND status IN ('queued', 'running') LIMIT 1").bind(siteId),
    ]);
    const site = foundSite(siteRead?.results[0] as SiteRow | undefined);
    if (write?.meta.changes !== 1) {
      if (site.taken_down_at !== null) throw new ApiError("site_taken_down", "This website has been taken offline. Contact us to restore it.");
      // The order is taken down, rev, rewrite, wording. The rev is checked first: a rev that is not the site's means this tab's whole
      // view is stale (its wording too), and the reload it prompts fixes both. With the rev current, the rewrite comes next (read in the
      // same batch, so it is what the write saw): its answer is the real reason, and the wording check would only be a symptom of it.
      if (site.rev !== body.rev) throw new ApiError("conflict", "This site changed in another tab or window", { currentRev: site.rev });
      if (rewriteRead?.results.length === 1) throw new ApiError("generation_in_progress", "New wording is being written. Your change was not saved.");
      throw new ApiError("wording_changed", "New wording arrived. Your wording change was not saved.");
    }
    const note = storedJsonNote(c);
    const current = toCurrentAi(aiRead?.results[0] as CurrentAiRow | undefined, note);
    const uploads = (uploadsRead?.results ?? []) as UploadRow[];
    return c.json({ rev: site.rev, issues: draftIssues(draftOf(site, note), current?.ai ?? null, site.id, c.env.ROOT_DOMAIN, uploads) });
  });

  return sites;
}
