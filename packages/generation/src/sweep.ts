import type { D1Database } from "@cloudflare/workers-types";
import { parseSnapshot } from "./snapshot.ts";
import { templateDraft } from "./template.ts";

/** Longer than the longest normal job: 3 attempts x 90 s + 2 s + 6 s of pauses, about 4.6 minutes (§6.3). */
export const JOB_STUCK_AFTER_MS = 6 * 60_000;
/** Rows read per query. */
export const SWEEP_BATCH = 25;
/**
 * Rows read per cron run, at most: a row counts once read, even when another writer ended or claimed it
 * first. Each row read gets one write, or two when the first throws, so 16 reads and at most 800 writes stay
 * under D1's 1,000 queries per invocation on Workers Paid, which production uses (design §1.4). On Workers
 * Free (50) a large run stops at the limit with every earlier write kept, and the next run carries on.
 */
export const SWEEP_MAX_PER_RUN = 400;

// The first term is exactly the WHERE of the partial index generations_one_active, so SQLite can read only active rows
// (sqlite.org/partialindex.html: the query must hold that term, AND-connected, as written). Both branches already
// require it, so the rows are the same; without it every run reads every row ever written (D1 bills rows read).
const STUCK = `SELECT id, kind, status, input_json FROM generations
WHERE status IN ('queued', 'running') AND ((status = 'queued' AND created_at < ?1) OR (status = 'running' AND started_at < ?1))
ORDER BY COALESCE(started_at, created_at) LIMIT ?2`;
const FAIL = "UPDATE generations SET status = 'failed', error_code = 'internal', finished_at = ?3 WHERE id = ?1 AND status = ?2";
const TEMPLATE =
  "UPDATE generations SET status = 'succeeded', output_json = ?3, used_fallback = 1, fallback_reason = 'provider_error', finished_at = ?4 WHERE id = ?1 AND status = ?2";

type StuckRow = { id: string; kind: "first" | "regenerate"; status: "queued" | "running"; input_json: string };

/** Ends one stuck row with one write, conditional on the status read: how it ended, or null if another writer came first. */
async function endStuckRow(db: D1Database, row: StuckRow, now: number): Promise<"fallback" | "failed" | null> {
  const snapshot = row.kind === "first" ? parseSnapshot(row.input_json) : null;
  const statement =
    snapshot === null
      ? db.prepare(FAIL).bind(row.id, row.status, now)
      : db.prepare(TEMPLATE).bind(row.id, row.status, JSON.stringify(templateDraft(snapshot.facts, snapshot.brief)), now);
  const { meta } = await statement.run();
  return meta.changes !== 1 ? null : snapshot === null ? "failed" : "fallback";
}

/**
 * The generator's cron (every 5 minutes, §6.3): a job still queued or running after
 * JOB_STUCK_AFTER_MS ends now. A first build gets the template (fallback_reason
 * 'provider_error'); a regeneration, or a first build whose input cannot be read, fails with
 * 'internal'. Each write is conditional on the status that was read. If anything for one row throws
 * (the template, its JSON or the write), that row fails with 'internal', as job.ts's templateEnding
 * ends a first build whose template cannot be made, and the run goes on to the next row.
 */
export async function sweepStuckJobs(env: { DB: D1Database }, now: number, limit = SWEEP_MAX_PER_RUN): Promise<{ fallback: number; failed: number }> {
  const counts = { fallback: 0, failed: 0 };
  let seen = 0;
  while (seen < limit) {
    const batch = Math.min(SWEEP_BATCH, limit - seen);
    const { results } = await env.DB.prepare(STUCK).bind(now - JOB_STUCK_AFTER_MS, batch).all<StuckRow>();
    for (const row of results) {
      try {
        const ended = await endStuckRow(env.DB, row, now);
        if (ended !== null) counts[ended] += 1;
      } catch {
        // One row must never stop the others (the oldest would be read first in every run): it fails with 'internal'.
        try {
          const { meta } = await env.DB.prepare(FAIL).bind(row.id, row.status, now).run();
          if (meta.changes === 1) counts.failed += 1;
        } catch {
          // It may still be stuck: a later read or run then reads it again.
        }
      }
    }
    // `seen` counts rows read, not rows ended. After its writes, a row read is normally no longer stuck at this `now`:
    // it is final (ended here or by someone else first), or the job claimed it first, so it is running from the
    // job's own start time. A row whose writes both threw may stay stuck and be read again. So the next read
    // moves on; in any case the run stops after at most `limit` rows read.
    seen += results.length;
    if (results.length < batch) break;
  }
  return counts;
}
