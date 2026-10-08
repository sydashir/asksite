import { LIMITS, newId, type GenerationInputSnapshot, type GenerationJob, type GenerationView } from "@asksite/core";
import type { D1Database, Queue } from "@cloudflare/workers-types";
import { retryWriteOnce } from "./d1-retry.ts";
import { dailyModelLimit, isGenerationEnabled, modelCallsToday, utcDayStart } from "./settings.ts";

export type RequestGenerationResult =
  | { ok: true; generation: GenerationView }
  | { ok: false; code: "generation_in_progress" | "generation_cap_reached" | "generation_disabled" | "budget_exhausted" | "internal" };

// Which rows count. INSERT_JOB and generationAllowance use these same two expressions, so they always agree.
// IS never yields NULL (unlike =), so a row with no error code still counts toward the site's day.
const COUNTS_TODAY = "NOT (error_code IS 'internal' AND started_at IS NULL)";
// IS (not =) keeps this NULL-safe if it is ever negated, as COUNTS_TODAY is; inside these plain WHERE clauses = and IS select the same rows, so no test can tell them apart.
const COUNTS_TOWARD_TOTAL = "kind = 'regenerate' AND (status IN ('queued', 'running', 'succeeded') OR (status = 'failed' AND error_code IS 'invalid_output'))";

// The site has a succeeded draft. requestGeneration reads this before it decides the kind; INSERT_JOB asks it again, so a draft that
// landed in between (another tab's first build finished) makes a "first" insert select no row, and a regeneration needs one.
const DRAFTED = "EXISTS (SELECT 1 FROM generations WHERE site_id = ?2 AND status = 'succeeded')";
// The per-site daily count, the per-owner daily count of regenerations and the per-owner total are checked in the INSERT itself,
// so they are exact even when one owner acts on two sites at once (design §6.4).
// Rows that failed before any job claimed them do not count (a failed queue send, or a stuck queued job the sweeper
// ended as internal). A first build the sweeper finished with the template does count: the owner received a draft.
// A first build neither counts toward nor is refused by the per-owner total (Decision 30).
// A regeneration counts toward the owner's total while it is queued or running, once it succeeded, or once it failed
// with invalid_output (P3-16 (B)). Failures that are not the owner's fault never count (a revoked key, the spend cap,
// 5xx, timeouts, internal errors). invalid_output counts because it is billed (up to 3 model calls) and the owner's own
// text can cause it. The daily model limit, the per-site 5 per UTC day and the per-owner 5 regenerations per UTC day keep
// protecting cost. The owner's day counts a regeneration by the same COUNTS_TODAY rule as the site's day (so a failed queue
// send does not count), from the owner's rows of every site; a first build is not in it, as it is not in the total.
const INSERT_JOB = `INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at)
SELECT ?1, ?2, ?3, ?4, 'queued', ?5, ?6
WHERE (SELECT COUNT(*) FROM generations WHERE site_id = ?2 AND created_at >= ?7 AND (${COUNTS_TODAY})) < ?8
  AND (?4 = 'first' OR ((SELECT COUNT(*) FROM generations WHERE owner_id = ?3 AND (${COUNTS_TOWARD_TOTAL})) < ?9
    AND (SELECT COUNT(*) FROM generations WHERE owner_id = ?3 AND kind = 'regenerate' AND created_at >= ?7 AND (${COUNTS_TODAY})) < ?10))
  AND ((?4 = 'regenerate') = ${DRAFTED})`;
// The owner's regenerations that count toward the total, counted exactly as INSERT_JOB counts them.
const OWNER_TOTAL = `SELECT COUNT(*) AS n FROM generations WHERE owner_id = ?1 AND (${COUNTS_TOWARD_TOTAL})`;
// In the same batch (one transaction): the audit row exists exactly when the job row does.
const INSERT_AUDIT = `INSERT INTO audit_log (at, actor, action, site_id, detail_json)
SELECT ?1, ?2, 'generation.requested', ?3, ?4 WHERE EXISTS (SELECT 1 FROM generations WHERE id = ?5)`;

// Last in the same batch: whether the site has a draft once the INSERT has run, which tells a refused INSERT's guard from its caps.
const DRAFTED_AFTER = "SELECT EXISTS (SELECT 1 FROM generations WHERE site_id = ?1 AND status = 'succeeded') AS drafted";

// Defence in depth: Plan 4 answers 404 for another owner's site and 423 for a taken-down one first.
const SITE_OPEN = "SELECT 1 AS one FROM sites WHERE id = ?1 AND owner_id = ?2 AND taken_down_at IS NULL";

const isOneActiveViolation = (error: unknown): boolean => error instanceof Error && /UNIQUE constraint failed: generations\.site_id/.test(error.message);

/**
 * Queues a generation for Plan 4's "Build my website" and "Write new wording" (design §6.4).
 * Never throws. A first build never blocks on the kill switch or today's model limit (it falls
 * back to the template in the job); a regeneration is refused at once, as advice: the exact
 * check is the job's claim. `kind` is the caller's intent, optional: given and different from what the
 * site is (a draft exists or not), nothing is queued and the answer is generation_in_progress.
 */
export async function requestGeneration(
  env: { DB: D1Database; GEN_QUEUE: Queue<GenerationJob>; GENERATION_ENABLED: string; DAILY_MODEL_LIMIT: string },
  input: { siteId: string; ownerId: string; snapshot: GenerationInputSnapshot; now: number; kind?: "first" | "regenerate" },
): Promise<RequestGenerationResult> {
  const { siteId, ownerId, snapshot, now } = input;
  try {
    if ((await env.DB.prepare(SITE_OPEN).bind(siteId, ownerId).first()) === null) return { ok: false, code: "internal" };
    const drafted = await env.DB.prepare("SELECT 1 AS one FROM generations WHERE site_id = ?1 AND status = 'succeeded' LIMIT 1").bind(siteId).first();
    const kind = drafted === null ? "first" : "regenerate";
    // A stale intent (this tab asked for a first build, but the site has a draft now; or asked to rewrite a site with none): nothing
    // is queued. generation_in_progress is the code Plan 4's Questionnaire answers by opening the build page, and its editor by
    // following the running job. A "regenerate" is not treated as a first build: a first build is outside the owner's caps (Decision 30).
    if (input.kind !== undefined && input.kind !== kind) return { ok: false, code: "generation_in_progress" };
    if (kind === "regenerate") {
      // The owner's used-up total is answered first, before the kill switch and today's model limit (P3-16 fix 1).
      // INSERT_JOB still enforces the total atomically.
      const total = await env.DB.prepare(OWNER_TOTAL).bind(ownerId).first<{ n: number }>();
      if ((total?.n ?? 0) >= LIMITS.generationsPerOwnerTotal) return { ok: false, code: "generation_cap_reached" };
      if (!(await isGenerationEnabled(env))) return { ok: false, code: "generation_disabled" };
      if ((await modelCallsToday(env.DB, now)) >= (await dailyModelLimit(env))) return { ok: false, code: "budget_exhausted" };
    }

    const id = newId();
    let inserted: number;
    let draftedNow: boolean;
    try {
      const [job, , after] = await env.DB.batch([
        env.DB.prepare(INSERT_JOB).bind(id, siteId, ownerId, kind, JSON.stringify(snapshot), now, utcDayStart(now), LIMITS.generationsPerSitePerDay, LIMITS.generationsPerOwnerTotal, LIMITS.generationsPerOwnerPerDay),
        env.DB.prepare(INSERT_AUDIT).bind(now, `owner:${ownerId}`, siteId, JSON.stringify({ generationId: id, kind }), id),
        env.DB.prepare(DRAFTED_AFTER).bind(siteId),
      ]);
      inserted = job?.meta.changes ?? 0;
      draftedNow = (after?.results[0] as { drafted?: number } | undefined)?.drafted === 1;
    } catch (error) {
      if (isOneActiveViolation(error)) return { ok: false, code: "generation_in_progress" };
      throw error;
    }
    if (inserted === 0) {
      // No row: a cap, or the guard (a draft landed after the read above). A draft never goes away, so the kind the site implies now
      // differs from the one tried only when the guard refused; then it is generation_in_progress, as a stale intent is.
      return { ok: false, code: draftedNow === (kind === "regenerate") ? "generation_cap_reached" : "generation_in_progress" };
    }

    try {
      await env.GEN_QUEUE.send({ v: 1, generationId: id });
    } catch {
      // Frees the one-active index so the owner can simply try again.
      // Retried once on D1's transient errors: the one-active index stays taken while this row is queued. Status-guarded, so a repeat is safe.
      await retryWriteOnce(() => env.DB.prepare("UPDATE generations SET status = 'failed', error_code = 'internal', finished_at = ?2 WHERE id = ?1 AND status = 'queued'").bind(id, now).run());
      return { ok: false, code: "internal" };
    }
    return { ok: true, generation: { id, kind, status: "queued", createdAt: now, finishedAt: null, errorCode: null, usedFallback: false, fallbackReason: null } };
  } catch {
    return { ok: false, code: "internal" };
  }
}

/**
 * What the owner has left (SiteView.limits): today, and regenerations in total for this owner, counted exactly as INSERT_JOB counts them.
 * generationsLeftToday is the site's allowance for a site with no draft (its next request is a first build, which the owner's daily
 * cap does not touch) and the smaller of the site's and the owner's regenerations left today for a site that has one.
 */
export async function generationAllowance(
  env: { DB: D1Database },
  input: { siteId: string; ownerId: string; now: number },
): Promise<{ generationsLeftToday: number; generationsLeftTotal: number }> {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM generations WHERE site_id = ?1 AND created_at >= ?3 AND (${COUNTS_TODAY})) AS today,
            (SELECT COUNT(*) FROM generations WHERE owner_id = ?2 AND kind = 'regenerate' AND created_at >= ?3 AND (${COUNTS_TODAY})) AS ownerToday,
            (SELECT COUNT(*) FROM generations WHERE owner_id = ?2 AND (${COUNTS_TOWARD_TOTAL})) AS total,
            EXISTS (SELECT 1 FROM generations WHERE site_id = ?1 AND status = 'succeeded') AS drafted`,
  )
    .bind(input.siteId, input.ownerId, utcDayStart(input.now))
    .first<{ today: number; ownerToday: number; total: number; drafted: number }>();
  const siteLeft = Math.max(0, LIMITS.generationsPerSitePerDay - (row?.today ?? 0));
  const ownerLeft = Math.max(0, LIMITS.generationsPerOwnerPerDay - (row?.ownerToday ?? 0));
  return {
    generationsLeftToday: row?.drafted ? Math.min(siteLeft, ownerLeft) : siteLeft,
    generationsLeftTotal: Math.max(0, LIMITS.generationsPerOwnerTotal - (row?.total ?? 0)),
  };
}
