import { ApiError, MAX_ISSUES, readJson, secondsUntilUtcMidnight } from "@asksite/app-common";
import { Brief, photoRefIssues, toIssues, type GenerationRow } from "@asksite/core";
import { Facts, type Theme } from "@asksite/site-schema";
import { Hono } from "hono";
import { z } from "zod";
import { assertNotTakenDown, ownedSite, parseStored } from "../db.ts";
import type { AppDeps, RequestGenerationResult } from "../deps.ts";
import { requireOwner } from "../session.ts";
import { currentAi, liveUploads, under } from "../site-view.ts";
import type { AppEnv } from "../types.ts";
import { storedJsonNote } from "./stored-json-note.ts";

/** The lifetime cap is not time-based: like the upload cap, the value only says "not at once" (decisions 15 and 40). */
const LIFETIME_CAP_RETRY_SECONDS = 86_400;

function refusal(code: Exclude<RequestGenerationResult, { ok: true }>["code"], now: number, lifetimeCapReached: boolean): ApiError {
  switch (code) {
    case "generation_in_progress":
      return new ApiError(code, "Your website is already being written. It will be ready soon.");
    case "generation_cap_reached":
      return lifetimeCapReached
        ? new ApiError(code, "You have used all the rewrites your account includes. Contact us if you need more.", { retryAfter: LIFETIME_CAP_RETRY_SECONDS })
        : new ApiError(code, "You have used all the rewrites for today. Try again tomorrow.", { retryAfter: secondsUntilUtcMidnight(now) });
    case "generation_disabled":
      return new ApiError(code, "Writing new wording is switched off right now. Your current wording is safe.");
    case "budget_exhausted":
      return new ApiError(code, "We have reached today's limit for writing new wording. Try again tomorrow.");
    case "internal":
      return new ApiError(code, "Something went wrong. Please try again.");
  }
}

/** Plan 3's rule for the job's kind (§6.4): once the site has a succeeded build, a request is a regeneration. */
async function isRegeneration(db: D1Database, siteId: string): Promise<boolean> {
  const drafted = await db.prepare("SELECT 1 FROM generations WHERE site_id = ? AND status = 'succeeded' LIMIT 1").bind(siteId).first();
  return drafted !== null;
}

/**
 * Pins the look the page shows now before a rebuild is asked for (A12 §3). An owner who never chose a theme sees
 * the AI draft's, which a new draft could change, so that theme is written into the stored edits first. Only a
 * null theme is set: an owner's choice and stored edits that are not valid JSON are left alone (read only once
 * json_valid passed them, inside a CASE: sqlite.org/lang_expr.html documents CASE as lazy, but not the order AND
 * evaluates its operands in; P4-21 item 6). Only $.theme changes and rev is not bumped, so no open tab gets a
 * conflict; PATCH /draft never replaces the pinned theme with a null one. Like PATCH /draft it writes nothing while a REGENERATE is
 * queued or running (the editor is frozen then): a rewrite already pinned the look when it was asked for, so this only ever skips
 * a request that the generator refuses as generation_in_progress anyway.
 */
async function pinTheme(db: D1Database, siteId: string, ownerId: string, theme: Theme, now: number): Promise<void> {
  await db
    .prepare(
      `UPDATE sites SET edits_json = json_set(edits_json, '$.theme', json(?1)), updated_at = ?2
       WHERE id = ?3 AND owner_id = ?4 AND CASE WHEN json_valid(edits_json) THEN json_extract(edits_json, '$.theme') IS NULL ELSE 0 END
         AND NOT EXISTS (SELECT 1 FROM generations WHERE site_id = ?3 AND kind = 'regenerate' AND status IN ('queued', 'running'))`,
    )
    .bind(JSON.stringify(theme), now, siteId, ownerId)
    .run();
}

/** POST and GET /api/sites/:siteId/generations (§3.1 step 4, §4.4, §6.4). */
export function generationRoutes(deps: AppDeps): Hono<AppEnv> {
  const generations = new Hono<AppEnv>();

  generations.post("/sites/:siteId/generations", requireOwner, async (c) => {
    await readJson(c, z.strictObject({}));
    const owner = c.get("owner");
    const db = c.env.DB;
    const site = await ownedSite(db, c.req.param("siteId"), owner.id);
    assertNotTakenDown(site);
    const facts = Facts.safeParse(parseStored(site.facts_json));
    const brief = Brief.safeParse(parseStored(site.brief_json));
    const issues = [
      ...(facts.success ? [] : under("facts", toIssues(facts.error))),
      ...(brief.success ? [] : under("brief", toIssues(brief.error))),
      ...photoRefIssues(parseStored(site.facts_json), site.id, c.env.ROOT_DOMAIN, await liveUploads(db, site.id)),
    ];
    if (!facts.success || !brief.success || issues.length > 0) {
      // Only the first MAX_ISSUES (P4-3): a malformed draft could otherwise list one issue per element.
      throw new ApiError("not_ready", "A few answers need attention before we can build your website", { issues: issues.slice(0, MAX_ISSUES) });
    }
    const now = Date.now();
    // Before the generator is asked, so a refused request leaves the page as it was; if the pin throws, nothing is queued.
    const before = await currentAi(db, site.id, storedJsonNote(c));
    if (before !== null) await pinTheme(db, site.id, owner.id, before.ai.draft.theme, now);
    const result = await deps.generation.requestGeneration(c.env, {
      siteId: site.id,
      ownerId: owner.id,
      snapshot: { facts: facts.data, brief: brief.data },
      now,
    });
    if (!result.ok) {
      // Which cap was hit: the site's daily one ("tomorrow") or the owner's lifetime one (decision 40). Only a
      // regeneration meets the lifetime cap, so a refused first build always hit the daily cap, even at 0 left in total.
      const lifetime =
        result.code === "generation_cap_reached" &&
        (await isRegeneration(db, site.id)) &&
        (await deps.generation.generationAllowance(c.env, { siteId: site.id, ownerId: owner.id, now })).generationsLeftTotal === 0;
      throw refusal(result.code, now, lifetime);
    }
    return c.json({ generation: result.generation }, 202);
  });

  generations.get("/sites/:siteId/generations/:generationId", requireOwner, async (c) => {
    const site = await ownedSite(c.env.DB, c.req.param("siteId"), c.get("owner").id);
    const row = await c.env.DB.prepare("SELECT * FROM generations WHERE id = ? AND site_id = ?")
      .bind(c.req.param("generationId"), site.id)
      .first<GenerationRow>();
    if (row === null) throw new ApiError("not_found", "Not found");
    return c.json(deps.generation.toGenerationView(row));
  });

  return generations;
}
