import type { D1Database } from "@cloudflare/workers-types";
import { parseSnapshot } from "./snapshot.ts";
import { templateDraft } from "./template.ts";

/** Longer than the longest normal job: 3 attempts x 90 s + 2 s + 6 s of pauses, about 4.6 minutes (§6.3). */
export const JOB_STUCK_AFTER_MS = 6 * 60_000;
/** Rows read per query. */
export const SWEEP_BATCH = 25;
/**
 * Rows read per cron run, at most: a row counts once read, even when another writer ended or claimed it
 * first. Each row read gets one write, or two when the first throws.
 * At most 816 D1 queries per run (16 reads + 800 writes). That is within Workers Paid on both Cloudflare pages: the D1
 * limits page (1,000 queries per invocation) and the Workers limits page (subrequests to internal services, default
 * 10,000).
 */
export const SWEEP_MAX_PER_RUN = 400;

// The first term is exactly the WHERE of the partial index generations_one_active, so SQLite can read only active rows
// (sqlite.org/partialindex.html: the query must hold that term, AND-connected, as written). Both branches already
// require it, so it matches the same set of rows; without it every run reads every row ever written (D1 bills rows
// read). SQL leaves the order of rows of equal age open (read through that index, they came in site_id order), so
// `id` breaks the tie: the order, and with it the rows each LIMITed read gets, is stable.
const STUCK = `SELECT id, kind, status, input_json FROM generations
WHERE status IN ('queued', 'running') AND ((status = 'queued' AND created_at < ?1) OR (status = 'running' AND started_at < ?1))
ORDER BY COALESCE(started_at, created_at), id LIMIT ?2`;
const FAIL = "UPDATE generations SET status = 'failed', error_code = 'internal', finished_at = ?3 WHERE id = ?1 AND status = ?2";
const TEMPLATE =
  "UPDATE generations SET status = 'succeeded', output_json = ?3, used_fallback = 1, fallback_reason = 'provider_error', finished_at = ?4 WHERE id = ?1 AND status = ?2";

type StuckRow = { id: string; kind: "first" | "regenerate"; status: "queued" | "running"; input_json: string };

/**
 * What one run did with the rows it read. Not a partition: `errors` counts each row whose ending threw (its template,
 * its JSON, its first write or the rescue write) once, by its id, however many of those steps threw and however many
 * times the run read it, and that row also counts in `failed` when the rescue write then ended it. A row that another
 * writer ended or claimed before this run's write counts in neither `fallback` nor `failed`.
 */
type SweepCounts = { fallback: number; failed: number; errors: number };

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
 * (the template, its JSON or the write), one more write, conditional the same way, tries to fail it with
 * 'internal', as job.ts's templateEnding ends a first build whose template cannot be made; if that write
 * throws too, the run gives up on the row for now. Either way the run goes on to the next row. After
 * a batch that ended no row while one of its rows' endings threw, the run stops (see the loop).
 */
export async function sweepStuckJobs(env: { DB: D1Database }, now: number, limit = SWEEP_MAX_PER_RUN): Promise<SweepCounts> {
  const counts = { fallback: 0, failed: 0 };
  const errored = new Set<string>();
  let seen = 0;
  while (seen < limit) {
    const batch = Math.min(SWEEP_BATCH, limit - seen);
    const { results } = await env.DB.prepare(STUCK).bind(now - JOB_STUCK_AFTER_MS, batch).all<StuckRow>();
    const endedBefore = counts.fallback + counts.failed;
    let threw = false;
    for (const row of results) {
      try {
        const ended = await endStuckRow(env.DB, row, now);
        if (ended !== null) counts[ended] += 1;
      } catch {
        // One row must never stop the others (the oldest would be read first in every run): it counts once in `errors`
        // (a Set of ids, so a row read again in this run is not counted again), and one more write tries to fail it
        // with 'internal'.
        errored.add(row.id);
        threw = true;
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
    // job's own start time. A row whose every write threw (one write when its template or JSON threw, else two) may
    // stay stuck and be read again, by this run's next read or by a later run. So the next read moves on; in any case
    // the run stops after at most `limit` rows read.
    seen += results.length;
    // Stop after a batch that ended no row while at least one of its rows' endings threw: that looks like a D1 outage,
    // and its rows stay stuck for the next cron run. Going on would read the rows still stuck again and again, up to 16
    // reads and 800 writes in one run, against a D1 whose writes are failing. A batch that ended a row goes on, and so
    // does a batch whose writes all changed nothing because another writer came first (nothing threw).
    if (threw && counts.fallback + counts.failed === endedBefore) break;
    if (results.length < batch) break;
  }
  return { ...counts, errors: errored.size };
}
