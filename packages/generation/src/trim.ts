import { LIMITS } from "@asksite/core";
import type { D1Database } from "@cloudflare/workers-types";

/** Rows cleared per run, at most: one D1 statement, so a backlog (the first run after deploy) drains over a few daily runs. */
export const TRIM_MAX_PER_RUN = 500;

// What a cleared input is: input_json is NOT NULL (0001_init.sql), and '{}' is what the tests of other tables already store. Only
// finished rows (the job claims 'queued' rows only, and the sweeper reads queued and running ones only) are cleared, so nothing
// ever parses the cleared value again. The cutoff is on finished_at, when the input stopped being needed, not on created_at.
// `input_json <> '{}'` keeps a cleared row out of the next run's LIMIT, so each run makes progress.
const TRIM = `UPDATE generations SET input_json = '{}'
WHERE id IN (
  SELECT id FROM generations
  WHERE status IN ('succeeded', 'failed') AND finished_at < ?1 AND input_json <> '{}'
  ORDER BY finished_at, id LIMIT ?2
)`;

/**
 * The generator's daily cron: clears generations.input_json (the owner's facts and brief) on finished rows whose finished_at is
 * more than LIMITS.generationInputRetentionDays days before `now` (a row finished exactly that long ago stays). output_json,
 * costs, tokens, status, error codes and every other column stay. Queued and running rows are never touched.
 */
export async function trimGenerationInputs(env: { DB: D1Database }, now: number, limit = TRIM_MAX_PER_RUN): Promise<{ cleared: number; limited: boolean }> {
  const cutoff = now - LIMITS.generationInputRetentionDays * 86_400_000;
  const { meta } = await env.DB.prepare(TRIM).bind(cutoff, limit).run();
  // limited: the run stopped at its bound, so a backlog may be left for the next run.
  return { cleared: meta.changes, limited: meta.changes === limit };
}
