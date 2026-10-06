import { LIMITS } from "@asksite/core";
import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TRIM_MAX_PER_RUN, trimGenerationInputs } from "../src/trim.ts";
import { clearTables, getGeneration, insertGeneration, seedOwnerSite, startLocalD1, type LocalD1 } from "./support/d1.ts";
import { FULL_SNAPSHOT } from "./support/samples.ts";

const NOW = Date.UTC(2026, 9, 6, 3, 17);
const DAY = 86_400_000;
const CUTOFF = NOW - 30 * DAY;
const INPUT = JSON.stringify(FULL_SNAPSHOT);
const OUTPUT = '{"copy":"kept"}';

let db: D1Database;
let local: LocalD1 | undefined;
beforeAll(async () => {
  local = startLocalD1(); // before the await: afterAll can close workerd even if this hook times out
  db = await local.ready;
}, 120_000);
afterAll(async () => local?.close());
beforeEach(async () => {
  await clearTables(db);
  for (const site of ["s1", "s2", "s3", "s4", "s5", "s6"]) await seedOwnerSite(db, "o1", site);
  await seedOwnerSite(db, "o2", "t1");
});

const finished = { output_json: OUTPUT, used_fallback: 1, fallback_reason: "provider_error", provider: "anthropic", model: "claude-opus-5-5", attempts: 2, input_tokens: 111, output_tokens: 222, cost_microusd: 333 } as const;

describe("trimGenerationInputs", () => {
  it("keeps the retention at 30 days", () => {
    expect(LIMITS.generationInputRetentionDays).toBe(30);
  });

  it.each(["succeeded", "failed"] as const)("clears a %s row finished 31 days ago and leaves one finished 29 days ago", async (status) => {
    const extra = status === "failed" ? { error_code: "internal" } : {};
    await insertGeneration(db, { id: "old", site_id: "s1", owner_id: "o1", status, input_json: INPUT, created_at: 5, started_at: 6, finished_at: NOW - 31 * DAY, ...finished, ...extra });
    await insertGeneration(db, { id: "new", site_id: "s2", owner_id: "o1", status, input_json: INPUT, created_at: 5, started_at: 6, finished_at: NOW - 29 * DAY, ...finished, ...extra });
    const before = { old: await getGeneration(db, "old"), new: await getGeneration(db, "new") };
    expect(await trimGenerationInputs({ DB: db }, NOW)).toEqual({ cleared: 1 });
    expect(await getGeneration(db, "old")).toEqual({ ...before.old, input_json: "{}" });
    expect(await getGeneration(db, "new")).toEqual(before.new);
    expect((await getGeneration(db, "new")).input_json).toBe(INPUT);
  });

  it("keeps output, costs, tokens, status and error codes of a cleared row", async () => {
    await insertGeneration(db, { id: "old", site_id: "s1", owner_id: "o1", status: "failed", error_code: "provider_timeout", input_json: INPUT, finished_at: NOW - 40 * DAY, ...finished });
    await trimGenerationInputs({ DB: db }, NOW);
    expect(await getGeneration(db, "old")).toMatchObject({ status: "failed", error_code: "provider_timeout", output_json: OUTPUT, input_json: "{}", cost_microusd: 333, input_tokens: 111, output_tokens: 222, provider: "anthropic" });
  });

  it("never touches a queued or a running row, whatever its age", async () => {
    await insertGeneration(db, { id: "q", site_id: "s1", owner_id: "o1", status: "queued", input_json: INPUT, created_at: 0 });
    await insertGeneration(db, { id: "r", site_id: "s2", owner_id: "o1", status: "running", input_json: INPUT, created_at: 0, started_at: 0 });
    // Not reachable by the job, but the status condition must hold on its own even if a finished_at were set.
    await db.prepare("UPDATE generations SET finished_at = ?1 WHERE id IN ('q', 'r')").bind(NOW - 400 * DAY).run();
    expect(await trimGenerationInputs({ DB: db }, NOW)).toEqual({ cleared: 0 });
    expect((await getGeneration(db, "q")).input_json).toBe(INPUT);
    expect((await getGeneration(db, "r")).input_json).toBe(INPUT);
  });

  it("uses finished_at, not created_at: a long-ago request finished recently keeps its input", async () => {
    await insertGeneration(db, { id: "a", site_id: "s1", owner_id: "o1", status: "succeeded", input_json: INPUT, created_at: NOW - 90 * DAY, finished_at: NOW - DAY });
    await insertGeneration(db, { id: "b", site_id: "s2", owner_id: "o1", status: "succeeded", input_json: INPUT, created_at: NOW - DAY, finished_at: NOW - 31 * DAY });
    expect(await trimGenerationInputs({ DB: db }, NOW)).toEqual({ cleared: 1 });
    expect((await getGeneration(db, "a")).input_json).toBe(INPUT);
    expect((await getGeneration(db, "b")).input_json).toBe("{}");
  });

  it("boundary: a row finished exactly 30 days ago stays; one millisecond older goes", async () => {
    await insertGeneration(db, { id: "edge", site_id: "s1", owner_id: "o1", status: "succeeded", input_json: INPUT, finished_at: CUTOFF });
    await insertGeneration(db, { id: "past", site_id: "s2", owner_id: "o1", status: "succeeded", input_json: INPUT, finished_at: CUTOFF - 1 });
    expect(await trimGenerationInputs({ DB: db }, NOW)).toEqual({ cleared: 1 });
    expect((await getGeneration(db, "edge")).input_json).toBe(INPUT);
    expect((await getGeneration(db, "past")).input_json).toBe("{}");
  });

  it("leaves a finished row with no finished_at alone", async () => {
    await insertGeneration(db, { id: "n", site_id: "s1", owner_id: "o1", status: "failed", input_json: INPUT });
    expect(await trimGenerationInputs({ DB: db }, NOW)).toEqual({ cleared: 0 });
    expect((await getGeneration(db, "n")).input_json).toBe(INPUT);
  });

  it("clears every owner's old rows alike and counts only rows it changed; a second run changes nothing", async () => {
    await insertGeneration(db, { id: "o1old", site_id: "s1", owner_id: "o1", status: "succeeded", input_json: INPUT, finished_at: NOW - 31 * DAY });
    await insertGeneration(db, { id: "o2old", site_id: "t1", owner_id: "o2", status: "failed", input_json: INPUT, finished_at: NOW - 31 * DAY });
    await insertGeneration(db, { id: "o1new", site_id: "s2", owner_id: "o1", status: "succeeded", input_json: INPUT, finished_at: NOW - DAY });
    expect(await trimGenerationInputs({ DB: db }, NOW)).toEqual({ cleared: 2 });
    expect(await trimGenerationInputs({ DB: db }, NOW)).toEqual({ cleared: 0 });
    expect([(await getGeneration(db, "o1old")).input_json, (await getGeneration(db, "o2old")).input_json, (await getGeneration(db, "o1new")).input_json]).toEqual(["{}", "{}", INPUT]);
  });

  it("clears at most `limit` rows per run, oldest finished first, and a later run takes the rest", async () => {
    expect(TRIM_MAX_PER_RUN).toBe(500);
    for (const [i, site] of ["s1", "s2", "s3"].entries())
      await insertGeneration(db, { id: `j${i}`, site_id: site, owner_id: "o1", status: "succeeded", input_json: INPUT, finished_at: NOW - (40 - i) * DAY });
    expect(await trimGenerationInputs({ DB: db }, NOW, 2)).toEqual({ cleared: 2 });
    expect([(await getGeneration(db, "j0")).input_json, (await getGeneration(db, "j1")).input_json, (await getGeneration(db, "j2")).input_json]).toEqual(["{}", "{}", INPUT]);
    expect(await trimGenerationInputs({ DB: db }, NOW, 2)).toEqual({ cleared: 1 });
    expect((await getGeneration(db, "j2")).input_json).toBe("{}");
  });
});
