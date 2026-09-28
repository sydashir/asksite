import { LIMITS, newId, type GenerationInputSnapshot, type GenerationJob, type GenerationView } from "@asksite/core";
import type { D1Database, Queue } from "@cloudflare/workers-types";
import { dailyModelLimit, isGenerationEnabled, modelCallsToday, utcDayStart } from "./settings.ts";

export type RequestGenerationResult =
  | { ok: true; generation: GenerationView }
  | { ok: false; code: "generation_in_progress" | "generation_cap_reached" | "generation_disabled" | "budget_exhausted" | "internal" };

// Which rows count. INSERT_JOB and generationAllowance use these same two expressions, so they always agree.
// IS never yields NULL (unlike =), so a row with no error code still counts toward the site's day.
const COUNTS_TODAY = "NOT (error_code IS 'internal' AND started_at IS NULL)";
const COUNTS_TOWARD_TOTAL = "kind = 'regenerate' AND (status IN ('queued', 'running') OR model_slot = 1)";

// The per-site daily count and the per-owner total are checked in the INSERT itself, so they are
// exact even when one owner acts on two sites at once (design §6.4).
// Rows that failed before any job claimed them do not count (a failed queue send, or a stuck queued job the sweeper
// ended as internal). A first build the sweeper finished with the template does count: the owner received a draft.
// A first build neither counts toward nor is refused by the per-owner total (Decision 30).
// A regeneration counts while it is queued or running, and afterwards only if it took a model call.
const INSERT_JOB = `INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at)
SELECT ?1, ?2, ?3, ?4, 'queued', ?5, ?6
WHERE (SELECT COUNT(*) FROM generations WHERE site_id = ?2 AND created_at >= ?7 AND (${COUNTS_TODAY})) < ?8
  AND (?4 = 'first' OR (SELECT COUNT(*) FROM generations WHERE owner_id = ?3 AND (${COUNTS_TOWARD_TOTAL})) < ?9)`;
// In the same batch (one transaction): the audit row exists exactly when the job row does.
const INSERT_AUDIT = `INSERT INTO audit_log (at, actor, action, site_id, detail_json)
SELECT ?1, ?2, 'generation.requested', ?3, ?4 WHERE EXISTS (SELECT 1 FROM generations WHERE id = ?5)`;

// Defence in depth: Plan 4 answers 404 for another owner's site and 423 for a taken-down one first.
const SITE_OPEN = "SELECT 1 AS one FROM sites WHERE id = ?1 AND owner_id = ?2 AND taken_down_at IS NULL";

const isOneActiveViolation = (error: unknown): boolean => error instanceof Error && /UNIQUE constraint failed: generations\.site_id/.test(error.message);

/**
 * Queues a generation for Plan 4's "Build my website" and "Write new wording" (design §6.4).
 * Never throws. A first build never blocks on the kill switch or today's model limit (it falls
 * back to the template in the job); a regeneration is refused at once, as advice: the exact
 * check is the job's claim.
 */
export async function requestGeneration(
  env: { DB: D1Database; GEN_QUEUE: Queue<GenerationJob>; GENERATION_ENABLED: string; DAILY_MODEL_LIMIT: string },
  input: { siteId: string; ownerId: string; snapshot: GenerationInputSnapshot; now: number },
): Promise<RequestGenerationResult> {
  const { siteId, ownerId, snapshot, now } = input;
  try {
    if ((await env.DB.prepare(SITE_OPEN).bind(siteId, ownerId).first()) === null) return { ok: false, code: "internal" };
    const drafted = await env.DB.prepare("SELECT 1 AS one FROM generations WHERE site_id = ?1 AND status = 'succeeded' LIMIT 1").bind(siteId).first();
    const kind = drafted === null ? "first" : "regenerate";
    if (kind === "regenerate") {
      if (!(await isGenerationEnabled(env))) return { ok: false, code: "generation_disabled" };
      if ((await modelCallsToday(env.DB, now)) >= (await dailyModelLimit(env))) return { ok: false, code: "budget_exhausted" };
    }

    const id = newId();
    let inserted: number;
    try {
      const [job] = await env.DB.batch([
        env.DB.prepare(INSERT_JOB).bind(id, siteId, ownerId, kind, JSON.stringify(snapshot), now, utcDayStart(now), LIMITS.generationsPerSitePerDay, LIMITS.generationsPerOwnerTotal),
        env.DB.prepare(INSERT_AUDIT).bind(now, `owner:${ownerId}`, siteId, JSON.stringify({ generationId: id, kind }), id),
      ]);
      inserted = job?.meta.changes ?? 0;
    } catch (error) {
      if (isOneActiveViolation(error)) return { ok: false, code: "generation_in_progress" };
      throw error;
    }
    if (inserted === 0) return { ok: false, code: "generation_cap_reached" };

    try {
      await env.GEN_QUEUE.send({ v: 1, generationId: id });
    } catch {
      // Frees the one-active index so the owner can simply try again.
      await env.DB.prepare("UPDATE generations SET status = 'failed', error_code = 'internal', finished_at = ?2 WHERE id = ?1 AND status = 'queued'").bind(id, now).run();
      return { ok: false, code: "internal" };
    }
    return { ok: true, generation: { id, kind, status: "queued", createdAt: now, finishedAt: null, errorCode: null, usedFallback: false, fallbackReason: null } };
  } catch {
    return { ok: false, code: "internal" };
  }
}

/** What the owner has left (SiteView.limits): today for this site, and regenerations in total for this owner, counted exactly as INSERT_JOB counts them. */
export async function generationAllowance(
  env: { DB: D1Database },
  input: { siteId: string; ownerId: string; now: number },
): Promise<{ generationsLeftToday: number; generationsLeftTotal: number }> {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM generations WHERE site_id = ?1 AND created_at >= ?3 AND (${COUNTS_TODAY})) AS today,
            (SELECT COUNT(*) FROM generations WHERE owner_id = ?2 AND (${COUNTS_TOWARD_TOTAL})) AS total`,
  )
    .bind(input.siteId, input.ownerId, utcDayStart(input.now))
    .first<{ today: number; total: number }>();
  return {
    generationsLeftToday: Math.max(0, LIMITS.generationsPerSitePerDay - (row?.today ?? 0)),
    generationsLeftTotal: Math.max(0, LIMITS.generationsPerOwnerTotal - (row?.total ?? 0)),
  };
}
