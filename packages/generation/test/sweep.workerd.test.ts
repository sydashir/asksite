import { AiDraft, type GenerationJob, type GenerationRow } from "@asksite/core";
import type { D1Database, Queue } from "@cloudflare/workers-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_DEPS, runGenerationJob, type JobEnv } from "../src/job.ts";
import { generationAllowance, requestGeneration } from "../src/request.ts";
import { modelCallsToday } from "../src/settings.ts";
import { JOB_STUCK_AFTER_MS, SWEEP_BATCH, SWEEP_MAX_PER_RUN, sweepStuckJobs } from "../src/sweep.ts";
import { templateDraft } from "../src/template.ts";
import { clearTables, getGeneration, insertGeneration, seedOwnerSite, startLocalD1, type LocalD1 } from "./support/d1.ts";
import { FULL_SNAPSHOT } from "./support/samples.ts";

// Every export of template.ts is a spy that calls the real function (vi.mock is hoisted and also applies to sweep.ts's
// import), so one test can make templateDraft throw once (Task 10 follow-up item 2).
vi.mock("../src/template.ts", { spy: true });

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
    expect(await sweepStuckJobs({ DB: db }, NOW)).toEqual({ fallback: 2, failed: 1, errors: 0 });
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
    expect(await sweepStuckJobs({ DB: db }, NOW)).toEqual({ fallback: 1, failed: 0, errors: 0 });
    expect(await sweepStuckJobs({ DB: db }, NOW)).toEqual({ fallback: 0, failed: 0, errors: 0 });
    expect((await getGeneration(db, "new")).status).toBe("queued");
    expect((await getGeneration(db, "run")).status).toBe("running");
  });

  it("fails a stuck first build whose input cannot be read", async () => {
    await insertGeneration(db, { id: "bad", site_id: "s1", owner_id: "o1", kind: "first", status: "queued", input_json: "not json", created_at: OLD });
    expect(await sweepStuckJobs({ DB: db }, NOW)).toEqual({ fallback: 0, failed: 1, errors: 0 });
    expect(await getGeneration(db, "bad")).toMatchObject({ status: "failed", error_code: "internal" });
  });

  it("handles at most `limit` jobs per run, oldest first", async () => {
    for (const [i, site] of ["s1", "s2", "s3"].entries())
      await insertGeneration(db, { id: `j${i}`, site_id: site, owner_id: "o1", status: "queued", input_json: INPUT, created_at: OLD - i });
    expect(await sweepStuckJobs({ DB: db }, NOW, 2)).toEqual({ fallback: 2, failed: 0, errors: 0 });
    expect((await getGeneration(db, "j0")).status).toBe("queued");
  });

  it("keeps going past one batch in a single run", async () => {
    for (let i = 0; i < 30; i++) {
      await seedOwnerSite(db, "o1", `b${i}`);
      await insertGeneration(db, { id: `b${i}`, site_id: `b${i}`, owner_id: "o1", status: "queued", input_json: INPUT, created_at: OLD - i });
    }
    expect(SWEEP_BATCH).toBeLessThan(30);
    expect(await sweepStuckJobs({ DB: db }, NOW)).toEqual({ fallback: 30, failed: 0, errors: 0 });
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
    expect(await sweepStuckJobs({ DB: jobFirst }, NOW)).toEqual({ fallback: 0, failed: 0, errors: 0 });
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
    expect(await sweepStuckJobs({ DB: db }, NOW)).toEqual({ fallback: 0, failed: 0, errors: 0 });
    expect([await getGeneration(db, "ok"), await getGeneration(db, "bad")]).toEqual(before);
  });

  it("measures a running job from started_at: exactly JOB_STUCK_AFTER_MS is not stuck yet, 1 ms more is", async () => {
    await insertGeneration(db, { id: "edge", site_id: "s1", owner_id: "o1", status: "running", input_json: INPUT, created_at: 0, started_at: NOW - JOB_STUCK_AFTER_MS });
    await insertGeneration(db, { id: "past", site_id: "s2", owner_id: "o1", status: "running", input_json: INPUT, created_at: 0, started_at: NOW - JOB_STUCK_AFTER_MS - 1 });
    expect(await sweepStuckJobs({ DB: db }, NOW)).toEqual({ fallback: 1, failed: 0, errors: 0 });
    expect((await getGeneration(db, "edge")).status).toBe("running");
    expect((await getGeneration(db, "past")).status).toBe("succeeded");
  });

  // Both ways (Task 10 follow-up item 7), so neither "queued rows first" nor "running rows first" passes.
  it.each<[string, number, number, "queued" | "running"]>([
    ["an older queued job before a newer running one, although the running one was created long before", OLD - 1, OLD, "queued"],
    ["an older running job before a newer queued one", OLD, OLD - 1, "running"],
  ])("ends the job stuck the longest first, a queued job counted from created_at and a running one from started_at: %s", async (_case, queuedSince, runningSince, first) => {
    await insertGeneration(db, { id: "queued", site_id: "s1", owner_id: "o1", status: "queued", input_json: INPUT, created_at: queuedSince });
    await insertGeneration(db, { id: "running", site_id: "s2", owner_id: "o1", status: "running", input_json: INPUT, created_at: 0, started_at: runningSince });
    expect(await sweepStuckJobs({ DB: db }, NOW, 1)).toEqual({ fallback: 1, failed: 0, errors: 0 });
    const statuses = [(await getGeneration(db, "queued")).status, (await getGeneration(db, "running")).status];
    expect(statuses).toEqual(first === "queued" ? ["succeeded", "running"] : ["queued", "succeeded"]);
  });

  it("reads SWEEP_BATCH rows a query and at most 400 a run: 16 reads and at most 800 writes (a second one when a row's first write throws) stay under D1's 1,000 queries per invocation (Decision 27)", async () => {
    expect([SWEEP_BATCH, SWEEP_MAX_PER_RUN]).toEqual([25, 400]);
    expect(Math.ceil(SWEEP_MAX_PER_RUN / SWEEP_BATCH) + 2 * SWEEP_MAX_PER_RUN).toBeLessThanOrEqual(1_000);
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
    expect(await sweepStuckJobs({ DB: counted }, NOW, 50)).toEqual({ fallback: 50, failed: 0, errors: 0 });
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
    expect(await sweepStuckJobs({ DB: recorded }, NOW)).toEqual({ fallback: 3, failed: 0, errors: 0 });
    expect(rowsRead).toHaveLength(1);
    expect(rowsRead[0]).toBeLessThanOrEqual(10);
  });

  // Task 10 follow-up 2 item 7: SQL leaves the order of rows of equal age open (the partial index read gave site_id order,
  // the full scan before it insertion order), so `id` breaks the tie and a LIMITed read gets the same rows whatever the plan.
  // The higher id is inserted first and on the lower site, so neither insertion order nor site_id order passes.
  it.each<[string, "queued" | "running"]>([
    ["two queued jobs created at the same time", "queued"],
    ["a running job started when a queued one was created", "running"],
  ])("ends jobs stuck equally long in id order, the lower id first: %s", async (_case, higherIdStatus) => {
    const since = higherIdStatus === "running" ? { created_at: 0, started_at: OLD } : { created_at: OLD };
    await insertGeneration(db, { id: "tie-b", site_id: "s1", owner_id: "o1", status: higherIdStatus, input_json: INPUT, ...since });
    await insertGeneration(db, { id: "tie-a", site_id: "s2", owner_id: "o1", status: "queued", input_json: INPUT, created_at: OLD });
    expect(await sweepStuckJobs({ DB: db }, NOW, 1)).toEqual({ fallback: 1, failed: 0, errors: 0 });
    expect([(await getGeneration(db, "tie-a")).status, (await getGeneration(db, "tie-b")).status]).toEqual(["succeeded", higherIdStatus]);
  });

  describe("the run's reads and its limit (Task 10 follow-up items 4 to 6)", () => {
    /** Wraps the local D1 and logs the LIMIT of every read the sweeper sends. */
    const countedReads = (limits: unknown[]): D1Database =>
      new Proxy(db, {
        get(target, prop, receiver) {
          if (prop !== "prepare") return Reflect.get(target, prop, receiver);
          return (sql: string) => {
            if (!sql.startsWith("SELECT")) return target.prepare(sql);
            return {
              bind: (...values: unknown[]) => {
                limits.push(values[1]);
                return target.prepare(sql).bind(...values);
              },
            };
          };
        },
      });
    /** `count` stuck queued first builds, each on its own site, the oldest `j0`. */
    const seedQueued = async (count: number): Promise<void> => {
      await db.batch(
        Array.from({ length: count }, (_, i) => [
          db.prepare("INSERT INTO sites (id, owner_id, created_at, updated_at) VALUES (?1, 'o1', 0, 0)").bind(`j${i}`),
          db.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at) VALUES (?1, ?1, 'o1', 'first', 'queued', ?2, ?3)").bind(`j${i}`, INPUT, OLD - count + i),
        ]).flat(),
      );
    };

    // The cron calls sweepStuckJobs(env, now) with no limit, so the default is what bounds a production run.
    it("stops at SWEEP_MAX_PER_RUN when called without a limit, as the cron calls it: 16 full reads and 400 writes", async () => {
      const limits: unknown[] = [];
      const writes: string[] = [];
      let next = 0;
      // A D1 that always has a full batch of stuck regenerations and ends each one it is asked to. It only records:
      // the sweeper catches what a write throws, so an assertion in here could be swallowed.
      const alwaysFull = {
        prepare: (sql: string) => ({
          bind: (...values: unknown[]) => ({
            all: async () => {
              limits.push(sql.startsWith("SELECT") ? values[1] : sql);
              return { results: Array.from({ length: Number(values[1]) }, () => ({ id: `x${next++}`, kind: "regenerate", status: "queued", input_json: "{}" })), meta: {} };
            },
            run: async () => {
              writes.push(sql.slice(0, 6));
              return { meta: { changes: 1 } };
            },
          }),
        }),
      } as unknown as D1Database;
      expect(await sweepStuckJobs({ DB: alwaysFull }, NOW)).toEqual({ fallback: 0, failed: SWEEP_MAX_PER_RUN, errors: 0 });
      expect(limits).toEqual(Array.from({ length: 16 }, () => SWEEP_BATCH));
      expect(writes).toEqual(Array.from({ length: 400 }, () => "UPDATE"));
    });

    it.each<[number, unknown[]]>([
      [1, [SWEEP_BATCH]],
      [30, [SWEEP_BATCH, SWEEP_BATCH]],
    ])("makes no further read after a read that returned fewer rows than it asked for: %i stuck jobs", async (count, reads) => {
      await seedQueued(count);
      const limits: unknown[] = [];
      expect(await sweepStuckJobs({ DB: countedReads(limits) }, NOW)).toEqual({ fallback: count, failed: 0, errors: 0 });
      expect(limits).toEqual(reads);
    });

    it("ends exactly `limit` jobs, the oldest, when the limit is not a multiple of SWEEP_BATCH: 30 of 40", async () => {
      await seedQueued(40);
      const limits: unknown[] = [];
      expect(30 % SWEEP_BATCH).not.toBe(0);
      expect(await sweepStuckJobs({ DB: countedReads(limits) }, NOW, 30)).toEqual({ fallback: 30, failed: 0, errors: 0 });
      expect(limits).toEqual([SWEEP_BATCH, 30 - SWEEP_BATCH]);
      const { results } = await db.prepare("SELECT id FROM generations WHERE status = 'queued' ORDER BY created_at").all<{ id: string }>();
      expect(results.map((row) => row.id)).toEqual(Array.from({ length: 10 }, (_, i) => `j${30 + i}`));
    });

    describe("when writes throw, with more stuck jobs than one read returns (Task 10 follow-up 3)", () => {
      /**
       * The local D1, logging every query the sweeper sends: "read", or "<id> template" / "<id> failed" for an UPDATE.
       * `write` runs before each UPDATE: it throws for a D1 outage (the UPDATE is then not sent), or is another
       * writer's step.
       */
      const logged = (log: string[], write: (id: string, kind: "template" | "failed") => Promise<void>): D1Database =>
        new Proxy(db, {
          get(target, prop, receiver) {
            if (prop !== "prepare") return Reflect.get(target, prop, receiver);
            return (sql: string) => {
              if (!sql.startsWith("UPDATE")) {
                log.push("read");
                return target.prepare(sql);
              }
              return {
                bind: (...values: unknown[]) => ({
                  run: async () => {
                    const kind = sql.includes("status = 'succeeded'") ? "template" : "failed";
                    log.push(`${String(values[0])} ${kind}`);
                    await write(String(values[0]), kind);
                    return target.prepare(sql).bind(...values).run();
                  },
                }),
              };
            };
          },
        });
      const stillQueued = async (): Promise<string[]> =>
        (await db.prepare("SELECT id FROM generations WHERE status = 'queued' ORDER BY created_at").all<{ id: string }>()).results.map((row) => row.id);

      // Item 3: before it, this outage read the same 25 oldest rows 16 times and sent 800 failing writes in one run.
      it("stops the run after a batch that ended no job while its endings threw (a D1 write outage: every UPDATE throws, 30 stuck jobs): one read, 25 first writes and 25 rescue writes, and each row once in errors", async () => {
        await seedQueued(30);
        const log: string[] = [];
        const outage = logged(log, async () => {
          throw new Error("D1 down");
        });
        expect(await sweepStuckJobs({ DB: outage }, NOW)).toEqual({ fallback: 0, failed: 0, errors: 25 });
        expect(log.filter((query) => query === "read")).toHaveLength(1);
        expect(log.filter((query) => query !== "read")).toHaveLength(50);
        expect(log).toEqual(["read", ...Array.from({ length: 25 }, (_, i) => [`j${i} template`, `j${i} failed`]).flat()]);
        // The rows stay stuck for the next cron run.
        expect(await stillQueued()).toEqual(Array.from({ length: 30 }, (_, i) => `j${i}`));
      });

      // j0 is the oldest, so the second read gets it again, with the 5 jobs the first read left: it counts once in
      // errors. In the second row, the first batch ends jobs only through rescue writes, and these count as writes
      // that ended a job.
      it.each<[string, (id: string, kind: "template" | "failed") => boolean, { fallback: number; failed: number; errors: number }]>([
        ["the oldest job's writes throw, every other write works", (id) => id === "j0", { fallback: 29, failed: 0, errors: 1 }],
        ["every template write throws, and so does the oldest job's rescue write: only rescue writes end jobs", (id, kind) => kind === "template" || id === "j0", { fallback: 0, failed: 29, errors: 30 }],
      ])("goes on to the next read after a batch that ended a job, although another job's ending threw (a partial outage): %s", async (_case, throws, counts) => {
        await seedQueued(30);
        const log: string[] = [];
        const partial = logged(log, async (id, kind) => {
          if (throws(id, kind)) throw new Error("D1 down");
        });
        expect(await sweepStuckJobs({ DB: partial }, NOW)).toEqual(counts);
        expect(log.filter((query) => query === "read")).toHaveLength(2);
        expect(await stillQueued()).toEqual(["j0"]);
      });

      it("goes on to the next read after a batch whose every write changed nothing because the job came first (nothing threw)", async () => {
        await seedQueued(30);
        const log: string[] = [];
        // Before each of the sweeper's writes, the job claims the row (job.ts CLAIM): the conditional write changes
        // 0 rows.
        const jobFirst = logged(log, async (id) => {
          await db.prepare("UPDATE generations SET status = 'running', started_at = ?2 WHERE id = ?1").bind(id, NOW).run();
        });
        expect(await sweepStuckJobs({ DB: jobFirst }, NOW)).toEqual({ fallback: 0, failed: 0, errors: 0 });
        expect(log.filter((query) => query === "read")).toHaveLength(2);
        expect(log.filter((query) => query !== "read")).toHaveLength(30);
        expect(await stillQueued()).toEqual([]);
      });
    });
  });

  describe("one row whose ending throws never stops the others (Task 10 follow-up item 2)", () => {
    const LATER = NOW + 5 * 60_000;
    /** The oldest stuck job, a first build, then a running first build and a queued regeneration. */
    const seedStuck = async (): Promise<void> => {
      await insertGeneration(db, { id: "poison", site_id: "s1", owner_id: "o1", kind: "first", status: "queued", input_json: INPUT, created_at: OLD - 3 });
      await insertGeneration(db, { id: "first", site_id: "s2", owner_id: "o1", kind: "first", status: "running", input_json: INPUT, created_at: 0, started_at: OLD - 2 });
      await insertGeneration(db, { id: "regen", site_id: "s3", owner_id: "o1", kind: "regenerate", status: "queued", input_json: INPUT, created_at: OLD - 1 });
    };
    const endedNormally = async (): Promise<void> => {
      expect(await getGeneration(db, "first")).toMatchObject({ status: "succeeded", used_fallback: 1, fallback_reason: "provider_error", error_code: null, finished_at: NOW });
      expect(await getGeneration(db, "regen")).toMatchObject({ status: "failed", error_code: "internal", output_json: null, finished_at: NOW });
    };
    /**
     * The test's D1, which logs every UPDATE the sweeper runs as "<id> template" or "<id> failed". The first `failures`
     * UPDATEs of row `id` throw instead of writing; `first` runs before the first of them (another writer's step).
     */
    const failingWrites = (id: string, failures: number, log: string[], first?: () => Promise<unknown>): D1Database => {
      let failed = 0;
      return new Proxy(db, {
        get(target, prop, receiver) {
          if (prop !== "prepare") return Reflect.get(target, prop, receiver);
          return (sql: string) => {
            if (!sql.startsWith("UPDATE")) return target.prepare(sql);
            return {
              bind: (...values: unknown[]) => ({
                run: async () => {
                  log.push(`${String(values[0])} ${sql.includes("status = 'succeeded'") ? "template" : "failed"}`);
                  if (values[0] !== id || failed >= failures) return target.prepare(sql).bind(...values).run();
                  if (failed++ === 0) await first?.();
                  throw new Error("D1 down");
                },
              }),
            };
          };
        },
      });
    };

    it("ends the oldest stuck first build failed/internal when its template throws, as the job does, and ends every other stuck job in the same run", async () => {
      await seedStuck();
      vi.mocked(templateDraft).mockImplementationOnce(() => {
        throw new Error("the template cannot be made");
      });
      // The counts are not a partition (item 4): the poison row counts in `failed` (the rescue write ended it) and in `errors`.
      expect(await sweepStuckJobs({ DB: db }, NOW)).toEqual({ fallback: 1, failed: 2, errors: 1 });
      expect(await getGeneration(db, "poison")).toMatchObject({ status: "failed", error_code: "internal", output_json: null, used_fallback: 0, fallback_reason: null, finished_at: NOW });
      await endedNormally();
      // The next run is not blocked: it ends a job that got stuck since.
      await insertGeneration(db, { id: "new", site_id: "s4", owner_id: "o1", kind: "regenerate", status: "queued", input_json: INPUT, created_at: LATER - JOB_STUCK_AFTER_MS - 1 });
      expect(await sweepStuckJobs({ DB: db }, LATER)).toEqual({ fallback: 0, failed: 1, errors: 0 });
      expect(await getGeneration(db, "new")).toMatchObject({ status: "failed", error_code: "internal", finished_at: LATER });
    });

    // The running rows (item 6) pin the second write's status binding: it is the status read, never the literal 'queued'.
    it.each<[string, "first" | "regenerate", "queued" | "running", number, string[]]>([
      ["a queued first build whose template write throws", "first", "queued", 1, ["poison template", "poison failed"]],
      ["a queued regeneration whose failed write throws once", "regenerate", "queued", 1, ["poison failed", "poison failed"]],
      ["a running first build whose template write throws", "first", "running", 1, ["poison template", "poison failed"]],
      ["a running regeneration whose failed write throws once", "regenerate", "running", 1, ["poison failed", "poison failed"]],
    ])("ends %s failed/internal with a second, conditional write, and ends every other stuck job in the same run", async (_case, kind, status, failures, poisonWrites) => {
      await seedStuck();
      await db.prepare("UPDATE generations SET kind = ?2, status = ?3, started_at = ?4 WHERE id = ?1").bind("poison", kind, status, status === "running" ? OLD - 3 : null).run();
      const log: string[] = [];
      expect(await sweepStuckJobs({ DB: failingWrites("poison", failures, log) }, NOW)).toEqual({ fallback: 1, failed: 2, errors: 1 });
      expect(log).toEqual([...poisonWrites, "first template", "regen failed"]);
      expect(await getGeneration(db, "poison")).toMatchObject({ status: "failed", error_code: "internal", output_json: null, used_fallback: 0, finished_at: NOW });
      await endedNormally();
    });

    it("keeps its second write conditional on the status it read: a job that claimed the row first keeps it", async () => {
      await seedStuck();
      const log: string[] = [];
      const claim = () => db.prepare("UPDATE generations SET status = 'running', started_at = ?2 WHERE id = ?1").bind("poison", NOW).run();
      expect(await sweepStuckJobs({ DB: failingWrites("poison", 1, log, claim) }, NOW)).toEqual({ fallback: 1, failed: 1, errors: 1 });
      expect(log).toEqual(["poison template", "poison failed", "first template", "regen failed"]);
      expect(await getGeneration(db, "poison")).toMatchObject({ status: "running", started_at: NOW, error_code: null, output_json: null, finished_at: null });
      await endedNormally();
    });

    it("goes on to the next row when both writes of a row throw: that row stays stuck, and it never blocks a later run", async () => {
      await seedStuck();
      const log: string[] = [];
      const broken = failingWrites("poison", Infinity, log);
      // Two steps of the poison row threw (its first write and the rescue write): it counts once in `errors` (item 4).
      expect(await sweepStuckJobs({ DB: broken }, NOW)).toEqual({ fallback: 1, failed: 1, errors: 1 });
      expect(log).toEqual(["poison template", "poison failed", "first template", "regen failed"]);
      expect(await getGeneration(db, "poison")).toMatchObject({ status: "queued", finished_at: null });
      await endedNormally();
      // Still the oldest stuck job, it is read first in every later run, and each run still ends the jobs behind it.
      for (const [at, site] of [[LATER, "s4"], [LATER + 5 * 60_000, "s5"]] as const) {
        await insertGeneration(db, { id: `new-${site}`, site_id: site, owner_id: "o1", kind: "regenerate", status: "queued", input_json: INPUT, created_at: at - JOB_STUCK_AFTER_MS - 1 });
        log.length = 0;
        expect(await sweepStuckJobs({ DB: broken }, at)).toEqual({ fallback: 0, failed: 1, errors: 1 });
        expect(log).toEqual(["poison template", "poison failed", `new-${site} failed`]);
        expect(await getGeneration(db, `new-${site}`)).toMatchObject({ status: "failed", error_code: "internal", finished_at: at });
      }
      expect((await getGeneration(db, "poison")).status).toBe("queued");
    });

    it("counts a row once in errors when its template throws and then its rescue write throws too", async () => {
      await seedStuck();
      vi.mocked(templateDraft).mockImplementationOnce(() => {
        throw new Error("the template cannot be made");
      });
      const log: string[] = [];
      expect(await sweepStuckJobs({ DB: failingWrites("poison", Infinity, log) }, NOW)).toEqual({ fallback: 1, failed: 1, errors: 1 });
      expect(log).toEqual(["poison failed", "first template", "regen failed"]);
      expect(await getGeneration(db, "poison")).toMatchObject({ status: "queued", finished_at: null });
      await endedNormally();
    });

    // Item 4: without `errors`, a run whose every write threw returned { fallback: 0, failed: 0 }, the same as a run with
    // nothing stuck, so the cron's generation.sweep line hid a D1 write outage.
    it("reports a D1 write outage (every UPDATE throws) in errors, not as an idle run: each row once, although both its writes threw", async () => {
      await seedStuck();
      const log: string[] = [];
      const outage = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop !== "prepare") return Reflect.get(target, prop, receiver);
          return (sql: string) => {
            if (!sql.startsWith("UPDATE")) return target.prepare(sql);
            return {
              bind: (...values: unknown[]) => ({
                run: async () => {
                  log.push(`${String(values[0])} ${sql.includes("status = 'succeeded'") ? "template" : "failed"}`);
                  throw new Error("D1 down");
                },
              }),
            };
          };
        },
      });
      expect(await sweepStuckJobs({ DB: outage }, NOW)).toEqual({ fallback: 0, failed: 0, errors: 3 });
      expect(log).toEqual(["poison template", "poison failed", "first template", "first failed", "regen failed", "regen failed"]);
      for (const id of ["poison", "first", "regen"]) expect((await getGeneration(db, id)).finished_at).toBeNull();
    });
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
    expect(await sweepStuckJobs({ DB: db }, NOW)).toEqual(stuck.end.status === "succeeded" ? { fallback: 1, failed: 0, errors: 0 } : { fallback: 0, failed: 1, errors: 0 });
    expect(await getGeneration(db, id)).toMatchObject({ kind: stuck.kind, created_at: START, finished_at: NOW, ...stuck.end });
    // A model slot the job took stays taken (it may have paid for a call), so it still counts toward today's model limit.
    expect(await modelCallsToday(db, NOW)).toBe(stuck.end.model_slot);
    expect(await allowance()).toEqual({ generationsLeftToday: stuck.today ? 4 : 5, generationsLeftTotal: 20 });
  });
});
