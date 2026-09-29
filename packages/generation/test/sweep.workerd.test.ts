import { AiDraft } from "@asksite/core";
import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JOB_STUCK_AFTER_MS, SWEEP_BATCH, sweepStuckJobs } from "../src/sweep.ts";
import { templateDraft } from "../src/template.ts";
import { clearTables, getGeneration, insertGeneration, seedOwnerSite, startLocalD1 } from "./support/d1.ts";
import { FULL_SNAPSHOT } from "./support/samples.ts";

const NOW = Date.UTC(2026, 8, 24, 15);
const OLD = NOW - JOB_STUCK_AFTER_MS - 1;
const INPUT = JSON.stringify(FULL_SNAPSHOT);

let db: D1Database;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await startLocalD1()), 120_000);
afterAll(async () => close());
beforeEach(async () => {
  await clearTables(db);
  for (const site of ["s1", "s2", "s3", "s4", "s5"]) await seedOwnerSite(db, "o1", site);
});

describe("sweepStuckJobs", () => {
  it("is six minutes: the longest normal job is 3 x 90 s plus 8 s of pauses", () => {
    expect(JOB_STUCK_AFTER_MS).toBe(360_000);
    expect(3 * 90_000 + 8_000).toBeLessThan(JOB_STUCK_AFTER_MS);
  });

  it("gives a stuck first build the template and fails a stuck regeneration", async () => {
    await insertGeneration(db, { id: "q1", site_id: "s1", owner_id: "o1", kind: "first", status: "queued", input_json: INPUT, created_at: OLD });
    await insertGeneration(db, { id: "r1", site_id: "s2", owner_id: "o1", kind: "first", status: "running", input_json: INPUT, created_at: 0, started_at: OLD });
    await insertGeneration(db, { id: "q2", site_id: "s3", owner_id: "o1", kind: "regenerate", status: "queued", input_json: INPUT, created_at: OLD });
    expect(await sweepStuckJobs({ DB: db }, NOW)).toEqual({ fallback: 2, failed: 1 });
    for (const id of ["q1", "r1"]) {
      const row = await getGeneration(db, id);
      expect(row).toMatchObject({ status: "succeeded", used_fallback: 1, fallback_reason: "provider_error", finished_at: NOW });
      expect(AiDraft.parse(JSON.parse(row.output_json!))).toEqual(templateDraft(FULL_SNAPSHOT.facts, FULL_SNAPSHOT.brief));
    }
    expect(await getGeneration(db, "q2")).toMatchObject({ status: "failed", error_code: "internal", finished_at: NOW, output_json: null });
  });

  it("leaves recent and finished jobs alone, and a second sweep does nothing", async () => {
    await insertGeneration(db, { id: "new", site_id: "s1", owner_id: "o1", status: "queued", input_json: INPUT, created_at: NOW - JOB_STUCK_AFTER_MS });
    await insertGeneration(db, { id: "run", site_id: "s2", owner_id: "o1", status: "running", input_json: INPUT, created_at: 0, started_at: NOW - 1000 });
    await insertGeneration(db, { id: "done", site_id: "s3", owner_id: "o1", status: "succeeded", input_json: INPUT, created_at: 0 });
    await insertGeneration(db, { id: "old", site_id: "s4", owner_id: "o1", status: "queued", input_json: INPUT, created_at: OLD });
    expect(await sweepStuckJobs({ DB: db }, NOW)).toEqual({ fallback: 1, failed: 0 });
    expect(await sweepStuckJobs({ DB: db }, NOW)).toEqual({ fallback: 0, failed: 0 });
    expect((await getGeneration(db, "new")).status).toBe("queued");
    expect((await getGeneration(db, "run")).status).toBe("running");
  });

  it("fails a stuck first build whose input cannot be read", async () => {
    await insertGeneration(db, { id: "bad", site_id: "s1", owner_id: "o1", kind: "first", status: "queued", input_json: "not json", created_at: OLD });
    expect(await sweepStuckJobs({ DB: db }, NOW)).toEqual({ fallback: 0, failed: 1 });
    expect(await getGeneration(db, "bad")).toMatchObject({ status: "failed", error_code: "internal" });
  });

  it("handles at most `limit` jobs per run, oldest first", async () => {
    for (const [i, site] of ["s1", "s2", "s3"].entries())
      await insertGeneration(db, { id: `j${i}`, site_id: site, owner_id: "o1", status: "queued", input_json: INPUT, created_at: OLD - i });
    expect(await sweepStuckJobs({ DB: db }, NOW, 2)).toEqual({ fallback: 2, failed: 0 });
    expect((await getGeneration(db, "j0")).status).toBe("queued");
  });

  it("keeps going past one batch in a single run", async () => {
    for (let i = 0; i < 30; i++) {
      await seedOwnerSite(db, "o1", `b${i}`);
      await insertGeneration(db, { id: `b${i}`, site_id: `b${i}`, owner_id: "o1", status: "queued", input_json: INPUT, created_at: OLD - i });
    }
    expect(SWEEP_BATCH).toBeLessThan(30);
    expect(await sweepStuckJobs({ DB: db }, NOW)).toEqual({ fallback: 30, failed: 0 });
  });
});
