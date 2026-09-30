import { AiDraft, type GenerationJob, type GenerationRow } from "@asksite/core";
import type { D1Database, Queue } from "@cloudflare/workers-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JOB_DEPS, runGenerationJob, type JobEnv } from "../src/job.ts";
import { generationAllowance, requestGeneration } from "../src/request.ts";
import { modelCallsToday } from "../src/settings.ts";
import { JOB_STUCK_AFTER_MS, SWEEP_BATCH, SWEEP_MAX_PER_RUN, sweepStuckJobs } from "../src/sweep.ts";
import { templateDraft } from "../src/template.ts";
import { clearTables, getGeneration, insertGeneration, seedOwnerSite, startLocalD1, type LocalD1 } from "./support/d1.ts";
import { FULL_SNAPSHOT } from "./support/samples.ts";

const NOW = Date.UTC(2026, 8, 24, 15);
const OLD = NOW - JOB_STUCK_AFTER_MS - 1;
const INPUT = JSON.stringify(FULL_SNAPSHOT);

let db: D1Database;
let local: LocalD1 | undefined;
beforeAll(async () => {
  local = startLocalD1(); // before the await: afterAll can close workerd even if this hook times out
  db = await local.ready;
}, 120_000);
afterAll(async () => local?.close());
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

  it("never overwrites a job that claimed or finished the row after the sweeper read it (each write is conditional on the status read)", async () => {
    await insertGeneration(db, { id: "q1", site_id: "s1", owner_id: "o1", kind: "first", status: "queued", input_json: INPUT, created_at: OLD - 3 });
    await insertGeneration(db, { id: "q2", site_id: "s2", owner_id: "o1", kind: "regenerate", status: "queued", input_json: INPUT, created_at: OLD - 2 });
    await insertGeneration(db, { id: "r1", site_id: "s3", owner_id: "o1", kind: "first", status: "running", input_json: INPUT, created_at: 0, started_at: OLD - 1 });
    await insertGeneration(db, { id: "r2", site_id: "s4", owner_id: "o1", kind: "regenerate", status: "running", input_json: INPUT, created_at: 0, started_at: OLD });
    const modelDraft = JSON.stringify(templateDraft(FULL_SNAPSHOT.facts, FULL_SNAPSHOT.brief));
    // Between the sweeper's read and each of its writes, the job gets there first: it claims a queued row (job.ts CLAIM)
    // and ends a running one (job.ts FINISH): a first build with the model's draft, a regeneration with a timeout.
    const jobWritesFirst = async (id: string): Promise<void> => {
      const row = await getGeneration(db, id);
      if (row.status === "queued") await db.prepare("UPDATE generations SET status = 'running', started_at = ?2 WHERE id = ?1").bind(id, NOW).run();
      else if (row.kind === "first") await db.prepare("UPDATE generations SET status = 'succeeded', output_json = ?2, attempts = 1, finished_at = ?3 WHERE id = ?1").bind(id, modelDraft, NOW - 1).run();
      else await db.prepare("UPDATE generations SET status = 'failed', error_code = 'provider_timeout', attempts = 3, finished_at = ?2 WHERE id = ?1").bind(id, NOW - 1).run();
    };
    const raced: string[] = [];
    const jobFirst = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          if (!sql.startsWith("UPDATE")) return target.prepare(sql);
          return {
            bind: (...values: unknown[]) => ({
              run: async () => {
                raced.push(String(values[0]));
                await jobWritesFirst(String(values[0]));
                return target.prepare(sql).bind(...values).run();
              },
            }),
          };
        };
      },
    });
    expect(await sweepStuckJobs({ DB: jobFirst }, NOW)).toEqual({ fallback: 0, failed: 0 });
    expect(raced).toEqual(["q1", "q2", "r1", "r2"]);
    for (const id of ["q1", "q2"]) expect(await getGeneration(db, id)).toMatchObject({ status: "running", started_at: NOW, finished_at: null, error_code: null, output_json: null });
    expect(await getGeneration(db, "r1")).toMatchObject({ status: "succeeded", output_json: modelDraft, used_fallback: 0, fallback_reason: null, attempts: 1, finished_at: NOW - 1 });
    expect(await getGeneration(db, "r2")).toMatchObject({ status: "failed", error_code: "provider_timeout", output_json: null, attempts: 3, finished_at: NOW - 1 });
  });

  it("never touches a finished job, even one that started long ago", async () => {
    const draft = JSON.stringify(templateDraft(FULL_SNAPSHOT.facts, FULL_SNAPSHOT.brief));
    await insertGeneration(db, { id: "ok", site_id: "s1", owner_id: "o1", kind: "first", status: "succeeded", input_json: INPUT, output_json: draft, model_slot: 1, attempts: 1, created_at: OLD, started_at: OLD, finished_at: OLD + 1 });
    await insertGeneration(db, { id: "bad", site_id: "s2", owner_id: "o1", kind: "regenerate", status: "failed", error_code: "invalid_output", input_json: INPUT, model_slot: 1, attempts: 3, created_at: OLD, started_at: OLD, finished_at: OLD + 1 });
    const before = [await getGeneration(db, "ok"), await getGeneration(db, "bad")];
    expect(await sweepStuckJobs({ DB: db }, NOW)).toEqual({ fallback: 0, failed: 0 });
    expect([await getGeneration(db, "ok"), await getGeneration(db, "bad")]).toEqual(before);
  });

  it("measures a running job from started_at: exactly JOB_STUCK_AFTER_MS is not stuck yet, 1 ms more is", async () => {
    await insertGeneration(db, { id: "edge", site_id: "s1", owner_id: "o1", status: "running", input_json: INPUT, created_at: 0, started_at: NOW - JOB_STUCK_AFTER_MS });
    await insertGeneration(db, { id: "past", site_id: "s2", owner_id: "o1", status: "running", input_json: INPUT, created_at: 0, started_at: NOW - JOB_STUCK_AFTER_MS - 1 });
    expect(await sweepStuckJobs({ DB: db }, NOW)).toEqual({ fallback: 1, failed: 0 });
    expect((await getGeneration(db, "edge")).status).toBe("running");
    expect((await getGeneration(db, "past")).status).toBe("succeeded");
  });

  it("ends the job stuck the longest first: a queued job counts from created_at, a running one from started_at", async () => {
    // Queued since OLD - 1, so stuck for longer than the running job, although that one was created long before.
    await insertGeneration(db, { id: "queued", site_id: "s1", owner_id: "o1", status: "queued", input_json: INPUT, created_at: OLD - 1 });
    await insertGeneration(db, { id: "running", site_id: "s2", owner_id: "o1", status: "running", input_json: INPUT, created_at: 0, started_at: OLD });
    expect(await sweepStuckJobs({ DB: db }, NOW, 1)).toEqual({ fallback: 1, failed: 0 });
    expect((await getGeneration(db, "queued")).status).toBe("succeeded");
    expect((await getGeneration(db, "running")).status).toBe("running");
  });

  it("reads SWEEP_BATCH rows a query and ends at most 400 a run: 16 reads and 400 writes stay under D1's 1,000 queries per invocation (Decision 27)", async () => {
    expect([SWEEP_BATCH, SWEEP_MAX_PER_RUN]).toEqual([25, 400]);
    expect(Math.ceil(SWEEP_MAX_PER_RUN / SWEEP_BATCH) + SWEEP_MAX_PER_RUN).toBeLessThanOrEqual(1_000);
    // 51 stuck jobs and a limit of 50: two full reads and 50 writes; the newest is left for the next run.
    await db.batch(
      Array.from({ length: 51 }, (_, i) => [
        db.prepare("INSERT INTO sites (id, owner_id, created_at, updated_at) VALUES (?1, 'o1', 0, 0)").bind(`m${i}`),
        db.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at) VALUES (?1, ?1, 'o1', 'first', 'queued', ?2, ?3)").bind(`m${i}`, INPUT, OLD - i),
      ]).flat(),
    );
    const queries: string[] = [];
    const counted = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          queries.push(sql.slice(0, 6));
          return target.prepare(sql);
        };
      },
    });
    expect(await sweepStuckJobs({ DB: counted }, NOW, 50)).toEqual({ fallback: 50, failed: 0 });
    expect(queries.filter((query) => query === "SELECT")).toHaveLength(2);
    expect(queries.filter((query) => query === "UPDATE")).toHaveLength(50);
    expect((await getGeneration(db, "m0")).status).toBe("queued");
  });

  // Task 10 follow-up item 1: finished rows are never deleted, and D1 bills the rows each query reads (meta.rows_read).
  // The read names the partial index's own term, status IN ('queued', 'running'), so SQLite can read only active rows.
  it("reads through the partial index of active jobs, so the rows it reads do not grow with the finished jobs", async () => {
    await db.batch(
      Array.from({ length: 300 }, (_, i) =>
        db.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at, finished_at) VALUES (?1, 's1', 'o1', 'regenerate', ?2, ?3, ?4, ?4)").bind(`done${i}`, i % 2 ? "succeeded" : "failed", INPUT, OLD - i),
      ),
    );
    for (const [i, site] of ["s2", "s3", "s4"].entries())
      await insertGeneration(db, { id: `stuck${i}`, site_id: site, owner_id: "o1", status: "queued", input_json: INPUT, created_at: OLD - i });
    const rowsRead: number[] = [];
    const recorded = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          if (!sql.startsWith("SELECT")) return target.prepare(sql);
          return {
            bind: (...values: unknown[]) => ({
              all: async () => {
                const result = await target.prepare(sql).bind(...values).all();
                rowsRead.push(result.meta.rows_read);
                return result;
              },
            }),
          };
        };
      },
    });
    expect(await sweepStuckJobs({ DB: recorded }, NOW)).toEqual({ fallback: 3, failed: 0 });
    expect(rowsRead).toHaveLength(1);
    expect(rowsRead[0]).toBeLessThanOrEqual(10);
  });
});

// task-10-additions A: which sweeper end-states count toward the site's 5 per UTC day and the owner's 20 regenerations,
// end to end. requestGeneration queues the job at START and its queue message is lost. A running job was also claimed
// at START by the job, which then could not read the row back and left it to the sweeper (job.ts, read_failed). The
// sweeper ends it at NOW, the same UTC day, and generationAllowance before and after shows how the end-state counts
// (request.ts COUNTS_TODAY and COUNTS_TOWARD_TOTAL). A job the sweeper failed before any job claimed it (internal,
// started_at NULL) is our infrastructure failure, so it counts toward neither. A template counts toward the day,
// because the owner received a draft. No sweeper end-state counts toward the owner's total.
describe("the sweeper's end-states and the allowance counts, end to end (task-10-additions A)", () => {
  const START = OLD;
  const lostQueue = { send: async () => {} } as unknown as Queue<GenerationJob>;
  const allowance = () => generationAllowance({ DB: db }, { siteId: "s1", ownerId: "o1", now: NOW });
  /** The job's claim works; reading the row back fails, so the job leaves the row running (job.ts, read_failed). */
  const cannotReadBack = (): D1Database =>
    new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          if (sql.startsWith("SELECT kind")) throw new Error("D1 down");
          return target.prepare(sql);
        };
      },
    });
  const jobEnv = (generationEnabled: string): JobEnv => ({
    DB: cannotReadBack(), GENERATION_ENABLED: generationEnabled, DAILY_MODEL_LIMIT: "30", ENVIRONMENT: "development", MODEL_PROVIDER: "fake", MODEL_ID: "fake-template",
  });
  type Stuck = { kind: "first" | "regenerate"; claimed?: "with a model slot" | "without a model slot"; unreadable?: true; end: Partial<GenerationRow>; today: boolean };

  it.each<[string, Stuck]>([
    ["a queued regeneration ends failed and counts toward neither", { kind: "regenerate", end: { status: "failed", error_code: "internal", started_at: null, model_slot: 0, output_json: null }, today: false }],
    ["a queued first build whose input cannot be read ends failed and counts toward neither", { kind: "first", unreadable: true, end: { status: "failed", error_code: "internal", started_at: null, model_slot: 0, output_json: null }, today: false }],
    ["a queued first build gets the template and counts toward the day only", { kind: "first", end: { status: "succeeded", used_fallback: 1, fallback_reason: "provider_error", error_code: null, started_at: null, model_slot: 0 }, today: true }],
    ["a running regeneration with a model slot ends failed and counts toward the day only", { kind: "regenerate", claimed: "with a model slot", end: { status: "failed", error_code: "internal", started_at: START, model_slot: 1, output_json: null }, today: true }],
    ["a running regeneration without a model slot ends failed and counts toward the day only", { kind: "regenerate", claimed: "without a model slot", end: { status: "failed", error_code: "internal", started_at: START, model_slot: 0, output_json: null }, today: true }],
    ["a running first build gets the template and counts toward the day only", { kind: "first", claimed: "with a model slot", end: { status: "succeeded", used_fallback: 1, fallback_reason: "provider_error", error_code: null, started_at: START, model_slot: 1 }, today: true }],
    ["a running first build whose input cannot be read ends failed and counts toward the day only", { kind: "first", claimed: "with a model slot", unreadable: true, end: { status: "failed", error_code: "internal", started_at: START, model_slot: 1, output_json: null }, today: true }],
  ])("%s", async (_name, stuck) => {
    // A regeneration needs a site whose first build succeeded; that was long ago, so it counts toward nothing today.
    if (stuck.kind === "regenerate") await insertGeneration(db, { id: "built", site_id: "s1", owner_id: "o1", status: "succeeded", created_at: 1, started_at: 1, finished_at: 1 });
    const request = await requestGeneration({ DB: db, GEN_QUEUE: lostQueue, GENERATION_ENABLED: "true", DAILY_MODEL_LIMIT: "30" }, { siteId: "s1", ownerId: "o1", snapshot: FULL_SNAPSHOT, now: START });
    if (!request.ok) throw new Error(`the request was refused: ${request.code}`);
    const { id } = request.generation;
    expect(request.generation.kind).toBe(stuck.kind);
    // No code stores input it cannot read back today: this stands for a stored snapshot that a later schema rejects.
    if (stuck.unreadable) await db.prepare("UPDATE generations SET input_json = 'not json' WHERE id = ?1").bind(id).run();
    if (stuck.claimed) {
      const env = jobEnv(stuck.claimed === "with a model slot" ? "true" : "false");
      expect(await runGenerationJob(env, id, { ...JOB_DEPS, now: () => START })).toMatchObject({ outcome: "read_failed" });
    }
    // While it is live, the job counts toward the day and, as a regeneration, toward the owner's total.
    expect(await allowance()).toEqual({ generationsLeftToday: 4, generationsLeftTotal: stuck.kind === "regenerate" ? 19 : 20 });
    expect(await sweepStuckJobs({ DB: db }, NOW)).toEqual(stuck.end.status === "succeeded" ? { fallback: 1, failed: 0 } : { fallback: 0, failed: 1 });
    expect(await getGeneration(db, id)).toMatchObject({ kind: stuck.kind, created_at: START, finished_at: NOW, ...stuck.end });
    // A model slot the job took stays taken (it may have paid for a call), so it still counts toward today's model limit.
    expect(await modelCallsToday(db, NOW)).toBe(stuck.end.model_slot);
    expect(await allowance()).toEqual({ generationsLeftToday: stuck.today ? 4 : 5, generationsLeftTotal: 20 });
  });
});
