import type { GenerationJob, GenerationRow } from "@asksite/core";
import type { D1Database, D1PreparedStatement, Queue } from "@cloudflare/workers-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generationAllowance, requestGeneration, type RequestGenerationResult } from "../src/request.ts";
import { utcDayStart } from "../src/settings.ts";
import { clearTables, getGeneration, insertGeneration, seedOwnerSite, setSetting, startLocalD1 } from "./support/d1.ts";
import { FULL_SNAPSHOT } from "./support/samples.ts";

const NOW = Date.UTC(2026, 8, 24, 15);

function queue(fail = false) {
  const sent: GenerationJob[] = [];
  const q = {
    async send(body: GenerationJob) {
      if (fail) throw new Error("queue down");
      sent.push(body);
    },
  } as unknown as Queue<GenerationJob>;
  return { q, sent };
}

let db: D1Database;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await startLocalD1()), 120_000);
afterAll(async () => close());
beforeEach(async () => {
  await clearTables(db);
  await seedOwnerSite(db, "o1", "s1");
  await seedOwnerSite(db, "o1", "s2");
});

const env = (q: Queue<GenerationJob>, enabled = "true", limit = "30") => ({ DB: db, GEN_QUEUE: q, GENERATION_ENABLED: enabled, DAILY_MODEL_LIMIT: limit });
const input = (siteId = "s1") => ({ siteId, ownerId: "o1", snapshot: FULL_SNAPSHOT, now: NOW });

/**
 * The test's D1 binding for one request (named by its site). It logs "<site> check" when requestGeneration sends a
 * check (a read) and "<site> insert" when it sends its INSERT_JOB batch, and forwards only what requestGeneration calls
 * (prepare, bind, first, batch). requestGeneration awaits each check before it sends the next, and three checks (the
 * kill switch, today's model calls, today's limit) follow its owner-total check. So a log in which both requests sent
 * every check before either INSERT proves that both owner-total checks had answered before either INSERT ran.
 */
function logged(site: string, steps: string[]): D1Database {
  const real = new Map<D1PreparedStatement, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      first: () => {
        steps.push(`${site} check`);
        return statement.first();
      },
    } as unknown as D1PreparedStatement;
    real.set(wrapped, statement);
    return wrapped;
  };
  return {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: (statements: D1PreparedStatement[]) => {
      steps.push(`${site} insert`);
      return db.batch(statements.map((statement) => real.get(statement) ?? statement));
    },
  } as unknown as D1Database;
}

/**
 * Sends the regenerations of s1 and s2 at once and asserts that the race happened: both reached INSERT_JOB, and neither
 * sent its INSERT before both had sent every check. So INSERT_JOB's own count decided, not the pre-check.
 */
async function raceTwoSites(): Promise<[RequestGenerationResult, RequestGenerationResult]> {
  const steps: string[] = [];
  const send = (site: string) => requestGeneration({ ...env(queue().q), DB: logged(site, steps) }, input(site));
  const results = await Promise.all([send("s1"), send("s2")]);
  expect(steps.slice(steps.findIndex((step) => step.endsWith(" insert"))).sort()).toEqual(["s1 insert", "s2 insert"]);
  return results;
}

describe("requestGeneration", () => {
  it("queues a first generation, sends { v: 1, generationId } and writes the audit row", async () => {
    const { q, sent } = queue();
    const result = await requestGeneration(env(q), input());
    expect(result).toEqual({ ok: true, generation: { id: expect.any(String), kind: "first", status: "queued", createdAt: NOW, finishedAt: null, errorCode: null, usedFallback: false, fallbackReason: null } });
    const id = result.ok ? result.generation.id : "";
    expect(sent).toEqual([{ v: 1, generationId: id }]);
    const row = await getGeneration(db, id);
    expect(JSON.parse(row.input_json)).toEqual(JSON.parse(JSON.stringify(FULL_SNAPSHOT)));
    const audit = await db.prepare("SELECT actor, action, site_id, detail_json FROM audit_log").all();
    expect(audit.results).toEqual([{ actor: "owner:o1", action: "generation.requested", site_id: "s1", detail_json: JSON.stringify({ generationId: id, kind: "first" }) }]);
  });

  it("is a regeneration once the site has a succeeded generation", async () => {
    await insertGeneration(db, { id: "old", site_id: "s1", owner_id: "o1", status: "succeeded", created_at: NOW - 86_400_000 });
    const result = await requestGeneration(env(queue().q), input());
    expect(result.ok && result.generation.kind).toBe("regenerate");
  });

  it("refuses a second job while one is queued or running (one-active index)", async () => {
    const { q, sent } = queue();
    expect((await requestGeneration(env(q), input())).ok).toBe(true);
    expect(await requestGeneration(env(q), input())).toEqual({ ok: false, code: "generation_in_progress" });
    expect(sent).toHaveLength(1);
  });

  it("allows 5 per site per UTC day; yesterday's jobs do not count", async () => {
    await insertGeneration(db, { id: "y", site_id: "s1", owner_id: "o1", status: "failed", created_at: utcDayStart(NOW) - 1 });
    for (let i = 0; i < 5; i++) await insertGeneration(db, { id: `t${i}`, site_id: "s1", owner_id: "o1", status: "failed", created_at: utcDayStart(NOW) + i });
    expect(await requestGeneration(env(queue().q), input())).toEqual({ ok: false, code: "generation_cap_reached" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE site_id = 's1'").first()).toEqual({ n: 0 });
    expect((await requestGeneration(env(queue().q), input("s2"))).ok).toBe(true);
  });

  it("allows 20 regenerations per owner in total, exactly, even with two sites at once; first builds do not count and still queue at the cap", async () => {
    await insertGeneration(db, { id: "f1", site_id: "s1", owner_id: "o1", status: "succeeded", created_at: 0 });
    await insertGeneration(db, { id: "f2", site_id: "s2", owner_id: "o1", status: "succeeded", created_at: 0 });
    for (let i = 0; i < 19; i++) await insertGeneration(db, { id: `t${i}`, site_id: i % 2 ? "s1" : "s2", owner_id: "o1", kind: "regenerate", status: "failed", error_code: "invalid_output", model_slot: 1, created_at: 0, started_at: 1 });
    const results = await raceTwoSites();
    expect(results.filter((r) => r.ok && r.generation.kind === "regenerate")).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "generation_cap_reached")).toHaveLength(1);
    // At the cap (20 regenerations): a new site's first build still queues; a regeneration is refused.
    await seedOwnerSite(db, "o1", "s3");
    const first = await requestGeneration(env(queue().q), input("s3"));
    expect(first.ok && first.generation.kind).toBe("first");
    expect(await requestGeneration(env(queue().q), input(results[0].ok ? "s2" : "s1"))).toEqual({ ok: false, code: "generation_cap_reached" });
    expect(await generationAllowance({ DB: db }, { siteId: "s3", ownerId: "o1", now: NOW })).toEqual({ generationsLeftToday: 4, generationsLeftTotal: 0 });
  });

  it("refuses a regeneration at once when generation is switched off; a first build still queues", async () => {
    expect((await requestGeneration(env(queue().q, "false"), input("s2"))).ok).toBe(true);
    await insertGeneration(db, { id: "old", site_id: "s1", owner_id: "o1", status: "succeeded" });
    expect(await requestGeneration(env(queue().q, "false"), input())).toEqual({ ok: false, code: "generation_disabled" });
    await setSetting(db, "generation.enabled", "false");
    expect(await requestGeneration(env(queue().q), input())).toEqual({ ok: false, code: "generation_disabled" });
  });

  it("refuses a regeneration at once when today's model calls are used up; a first build still queues", async () => {
    await insertGeneration(db, { id: "used", site_id: "s2", owner_id: "o1", status: "succeeded", model_slot: 1, started_at: NOW - 1 });
    expect(await requestGeneration(env(queue().q, "true", "1"), input("s2"))).toEqual({ ok: false, code: "budget_exhausted" });
    expect((await requestGeneration(env(queue().q, "true", "1"), input("s1"))).ok).toBe(true);
  });

  describe("a used-up lifetime is answered first for a regeneration (P3-16 fix 1)", () => {
    /** Owner o1's site s1 is built and has `count` regenerations, none of them today, each succeeded or ended as `end`. */
    async function regenerations(count: number, end: Partial<GenerationRow> = {}): Promise<void> {
      await insertGeneration(db, { id: "built", site_id: "s1", owner_id: "o1", status: "succeeded", created_at: 0 });
      for (let i = 0; i < count; i++) await insertGeneration(db, { id: `r${i}`, site_id: "s1", owner_id: "o1", kind: "regenerate", status: "succeeded", model_slot: 1, attempts: 1, created_at: 0, started_at: 0, finished_at: 0, ...end });
    }
    /** Today's model calls: one call, from a first build on s2. */
    const useTodaysCall = () => insertGeneration(db, { id: "used", site_id: "s2", owner_id: "o1", status: "succeeded", model_slot: 1, started_at: NOW - 1 });

    it("answers generation_cap_reached, not generation_disabled, when the owner's 20 are used up and generation is switched off", async () => {
      await regenerations(20);
      const { q, sent } = queue();
      expect(await requestGeneration(env(q, "false"), input())).toEqual({ ok: false, code: "generation_cap_reached" });
      expect(sent).toEqual([]);
    });

    it("answers generation_cap_reached, not generation_disabled, when the owner's 20 all ended invalid_output and generation is switched off", async () => {
      await regenerations(20, { status: "failed", error_code: "invalid_output", attempts: 3 });
      expect(await requestGeneration(env(queue().q, "false"), input())).toEqual({ ok: false, code: "generation_cap_reached" });
    });

    it("answers generation_cap_reached, not budget_exhausted, when the owner's 20 are used up and today's model calls are too", async () => {
      await regenerations(20);
      await useTodaysCall();
      expect(await requestGeneration(env(queue().q, "true", "1"), input())).toEqual({ ok: false, code: "generation_cap_reached" });
    });

    it("still answers generation_disabled and budget_exhausted while 1 of the 20 is left", async () => {
      await regenerations(19);
      expect(await requestGeneration(env(queue().q, "false"), input())).toEqual({ ok: false, code: "generation_disabled" });
      await useTodaysCall();
      expect(await requestGeneration(env(queue().q, "true", "1"), input())).toEqual({ ok: false, code: "budget_exhausted" });
    });

    it("never refuses a first build: at the used-up lifetime with generation switched off, a new site's first build still queues (Decision 30)", async () => {
      await regenerations(20);
      await seedOwnerSite(db, "o1", "s3");
      const result = await requestGeneration(env(queue().q, "false"), input("s3"));
      expect(result.ok && result.generation.kind).toBe("first");
    });
  });

  it("marks the row failed and frees the site when the queue send fails", async () => {
    expect(await requestGeneration(env(queue(true).q), input())).toEqual({ ok: false, code: "internal" });
    const row = await db.prepare("SELECT status, error_code, finished_at FROM generations").first();
    expect(row).toEqual({ status: "failed", error_code: "internal", finished_at: NOW });
    const retry = await requestGeneration(env(queue().q), input());
    expect(retry.ok && retry.generation.kind).toBe("first");
  });

  it("leaves a row the job already claimed alone when the send then fails: the failed-send UPDATE ends only a queued row (P3-16 fix 4 b)", async () => {
    // This queue stands in for a job that claims the row between the INSERT and the failed send's return.
    const racing = {
      async send(body: GenerationJob) {
        await db.prepare("UPDATE generations SET status = 'running', started_at = ?2 WHERE id = ?1 AND status = 'queued'").bind(body.generationId, NOW).run();
        throw new Error("queue send failed");
      },
    } as unknown as Queue<GenerationJob>;
    expect(await requestGeneration(env(racing), input())).toEqual({ ok: false, code: "internal" });
    const rows = await db.prepare("SELECT status, error_code, started_at, finished_at FROM generations").all();
    expect(rows.results).toEqual([{ status: "running", error_code: null, started_at: NOW, finished_at: null }]);
  });

  it("maps only the one-active index's error to generation_in_progress: another UNIQUE error is internal (P3-16 fix 4 c)", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    await insertGeneration(db, { id, site_id: "s2", owner_id: "o1", status: "failed", error_code: "internal", created_at: 0 });
    // The premise, from the real D1: a job row whose id is taken fails on the primary key, and s1 has no active job.
    const taken = db.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at) VALUES (?1, 's1', 'o1', 'first', 'queued', '{}', 0)").bind(id);
    await expect(taken.run()).rejects.toThrow(/UNIQUE constraint failed: generations\.id/);
    // newId() is crypto.randomUUID(): this request's job row gets the taken id.
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue(id);
    try {
      expect(await requestGeneration(env(queue().q), input())).toEqual({ ok: false, code: "internal" });
      expect(uuid).toHaveBeenCalledTimes(1);
    } finally {
      uuid.mockRestore();
    }
    expect(await db.prepare("SELECT (SELECT COUNT(*) FROM generations) AS jobs, (SELECT COUNT(*) FROM audit_log) AS audits").first()).toEqual({ jobs: 1, audits: 0 });
  });

  it("refuses a site of another owner or a taken-down site, writing and sending nothing", async () => {
    const { q, sent } = queue();
    await seedOwnerSite(db, "o2", "s3");
    expect(await requestGeneration(env(q), input("s3"))).toEqual({ ok: false, code: "internal" });
    await db.prepare("UPDATE sites SET taken_down_at = 1 WHERE id = 's1'").run();
    expect(await requestGeneration(env(q), input("s1"))).toEqual({ ok: false, code: "internal" });
    expect(sent).toEqual([]);
    expect(await db.prepare("SELECT (SELECT COUNT(*) FROM generations) + (SELECT COUNT(*) FROM audit_log) AS n").first()).toEqual({ n: 0 });
  });

  it("returns internal instead of throwing when the database fails", async () => {
    const broken = { prepare() { throw new Error("D1 down"); } } as unknown as D1Database;
    expect(await requestGeneration({ ...env(queue().q), DB: broken }, input())).toEqual({ ok: false, code: "internal" });
  });
});

describe("generationAllowance", () => {
  it("reports what is left today for the site and in total for the owner; first builds do not count toward the total", async () => {
    await insertGeneration(db, { id: "a", site_id: "s1", owner_id: "o1", kind: "regenerate", status: "failed", error_code: "invalid_output", model_slot: 1, created_at: utcDayStart(NOW), started_at: utcDayStart(NOW) });
    await insertGeneration(db, { id: "b", site_id: "s1", owner_id: "o1", status: "succeeded", created_at: utcDayStart(NOW) - 1 });
    await insertGeneration(db, { id: "c", site_id: "s2", owner_id: "o1", status: "succeeded", created_at: NOW });
    expect(await generationAllowance({ DB: db }, { siteId: "s1", ownerId: "o1", now: NOW })).toEqual({ generationsLeftToday: 4, generationsLeftTotal: 19 });
  });

  it("never goes below zero", async () => {
    for (let i = 0; i < 21; i++) await insertGeneration(db, { id: `t${i}`, site_id: "s1", owner_id: "o1", kind: "regenerate", status: "failed", error_code: "invalid_output", model_slot: 1, created_at: NOW, started_at: NOW });
    expect(await generationAllowance({ DB: db }, { siteId: "s1", ownerId: "o1", now: NOW })).toEqual({ generationsLeftToday: 0, generationsLeftTotal: 0 });
  });
});

// P3-11 (p) and P3-16 (B, which replaced (q)): which rows count. Each row is one state a generations row can be in,
// seeded directly here and named after the code that writes it: requestGeneration (INSERT_JOB writes the queued row;
// its failed-send UPDATE ends it), the job (Task 9: its claim makes the row running, its terminal write ends it) or the
// sweeper (Task 10). Queued and running rows are live states, not end-states. The end-to-end proofs come with Tasks 9
// and 10. today: counts toward the site's 5 per UTC day. total: counts toward the owner's 20 regenerations.
type RowState = { row: Pick<GenerationRow, "kind" | "status"> & Partial<GenerationRow>; started: boolean; today: boolean; total: boolean };
const ROW_STATES: [string, RowState][] = [
  ["the job: a regeneration refused at claim time because generation is switched off", { row: { kind: "regenerate", status: "failed", error_code: "generation_disabled" }, started: true, today: true, total: false }],
  ["the job: a regeneration refused at claim time because today's model calls are used up", { row: { kind: "regenerate", status: "failed", error_code: "budget_exhausted" }, started: true, today: true, total: false }],
  // The job ends these two alike except for model (task-9-brief.md, callModel): a provider it cannot build (no key)
  // returns `{ ...NO_SPEND, provider: env.MODEL_PROVIDER }`, so model stays null, while the input guard's refusal stores
  // `result.model ?? env.MODEL_ID`: no call was sent, so result.model is null and the requested id is stored (as
  // task-9-additions.md E also gives for a missing model). Neither count reads model.
  ["the job: a regeneration with no key (provider_unavailable, 0 attempts, slot given back, no model)", { row: { kind: "regenerate", status: "failed", error_code: "provider_unavailable", attempts: 0, provider: "anthropic", model: null }, started: true, today: true, total: false }],
  ["the job: a regeneration whose attempt 1 the input guard refused (provider_unavailable, 0 attempts, slot given back, the requested model)", { row: { kind: "regenerate", status: "failed", error_code: "provider_unavailable", attempts: 0, provider: "anthropic", model: "claude-opus-5-5" }, started: true, today: true, total: false }],
  // These two differ only in provider and model, which neither count reads. The job's costUnknown write keeps the slot,
  // records attempts, tokens and cost as 0 (unknown, task-9-additions.md C) and stores the configured provider and the
  // requested model (Task 9 follow-up item 3). The sweeper's UPDATE sets only status, error_code and finished_at
  // (task-10-brief.md, sweepStuckJobs), so the row keeps the claim's NULL provider and model.
  ["the job: a regeneration whose own code threw after a call (costUnknown: internal, 0 attempts, slot kept, the requested model)", { row: { kind: "regenerate", status: "failed", error_code: "internal", model_slot: 1, attempts: 0, provider: "anthropic", model: "claude-opus-5-5" }, started: true, today: true, total: false }],
  ["the sweeper: a running regeneration with a model slot, ended as internal", { row: { kind: "regenerate", status: "failed", error_code: "internal", model_slot: 1 }, started: true, today: true, total: false }],
  ["the sweeper: a running regeneration without a model slot, ended as internal", { row: { kind: "regenerate", status: "failed", error_code: "internal", model_slot: 0 }, started: true, today: true, total: false }],
  ["the sweeper: a queued regeneration never claimed, ended as internal", { row: { kind: "regenerate", status: "failed", error_code: "internal" }, started: false, today: false, total: false }],
  // task-10-brief.md:138-143 and task-10-additions.md A: a stuck queued first build with readable input gets the
  // template (error_code NULL, started_at NULL, model_slot 0). It counts toward the day: the owner received a draft.
  ["the sweeper: a queued first build never claimed, finished with the template", { row: { kind: "first", status: "succeeded", used_fallback: 1, fallback_reason: "provider_error", error_code: null, model_slot: 0 }, started: false, today: true, total: false }],
  ["requestGeneration: a regeneration whose queue send failed", { row: { kind: "regenerate", status: "failed", error_code: "internal" }, started: false, today: false, total: false }],
  ["requestGeneration: a first build whose queue send failed", { row: { kind: "first", status: "failed", error_code: "internal" }, started: false, today: false, total: false }],
  ["requestGeneration: a queued regeneration (live)", { row: { kind: "regenerate", status: "queued" }, started: false, today: true, total: true }],
  ["the job's claim: a running regeneration without a model slot (live)", { row: { kind: "regenerate", status: "running", model_slot: 0 }, started: true, today: true, total: true }],
  ["the job's claim: a running regeneration with a model slot (live)", { row: { kind: "regenerate", status: "running", model_slot: 1 }, started: true, today: true, total: true }],
  ["the job: a succeeded regeneration", { row: { kind: "regenerate", status: "succeeded", model_slot: 1, attempts: 1 }, started: true, today: true, total: true }],
  ["the job: a regeneration that failed after its model calls (invalid_output)", { row: { kind: "regenerate", status: "failed", error_code: "invalid_output", model_slot: 1, attempts: 3 }, started: true, today: true, total: true }],
  ["the job: a regeneration whose provider failed after its model calls (provider_unavailable, 3 attempts)", { row: { kind: "regenerate", status: "failed", error_code: "provider_unavailable", model_slot: 1, attempts: 3 }, started: true, today: true, total: false }],
  ["the job: a regeneration whose provider timed out after its model calls (provider_timeout, 3 attempts)", { row: { kind: "regenerate", status: "failed", error_code: "provider_timeout", model_slot: 1, attempts: 3 }, started: true, today: true, total: false }],
  ["requestGeneration: a queued first build (live)", { row: { kind: "first", status: "queued" }, started: false, today: true, total: false }],
  ["the job's claim: a running first build with a model slot (live)", { row: { kind: "first", status: "running", model_slot: 1 }, started: true, today: true, total: false }],
  ["the job: a first build that took a model call", { row: { kind: "first", status: "succeeded", model_slot: 1, attempts: 1 }, started: true, today: true, total: false }],
  ["the job: a first build that got the template without a model call", { row: { kind: "first", status: "succeeded", used_fallback: 1, fallback_reason: "budget" }, started: true, today: true, total: false }],
];

describe("which rows count toward the site's day and the owner's total (P3-11 (p), P3-16 (B)); generationAllowance agrees with INSERT_JOB", () => {
  const DAY = utcDayStart(NOW);
  const allowance = (siteId = "s1") => generationAllowance({ DB: db }, { siteId, ownerId: "o1", now: NOW });
  const outcome = (result: RequestGenerationResult) => (result.ok ? result.generation.kind : result.code);

  /** Seeds one row of owner o1 in the given state, created (and, once claimed, started) at `at`. */
  async function seedRowState(id: string, siteId: string, at: number, state: RowState): Promise<void> {
    const finished = state.row.status === "failed" || state.row.status === "succeeded";
    await insertGeneration(db, { id, site_id: siteId, owner_id: "o1", created_at: at, ...(state.started ? { started_at: at } : {}), ...(finished ? { finished_at: at } : {}), ...state.row });
  }

  /** A row that took a model call and succeeded, long before today: it counts toward the total if it is a regeneration. */
  async function succeeded(id: string, siteId: string, kind: "first" | "regenerate"): Promise<void> {
    await insertGeneration(db, { id, site_id: siteId, owner_id: "o1", kind, status: "succeeded", model_slot: 1, attempts: 1, created_at: 1, started_at: 1, finished_at: 1 });
  }

  /** Stands in for the job (Task 9): claims the queued row with a model slot and succeeds. */
  async function finishJob(id: string): Promise<void> {
    await db.prepare("UPDATE generations SET status = 'succeeded', started_at = ?2, model_slot = 1, attempts = 1, finished_at = ?2 WHERE id = ?1 AND status = 'queued'").bind(id, NOW).run();
  }

  /**
   * Sends one request per site at once and holds each request's INSERT_JOB batch until every request has run its
   * pre-checks (reached its batch, or ended without one). So every pre-check sees the same rows and INSERT_JOB alone
   * decides: the race its own counts exist for (design 6.4).
   */
  async function atOnce(siteIds: string[]): Promise<RequestGenerationResult[]> {
    let waiting = siteIds.length;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    return Promise.all(
      siteIds.map(async (siteId) => {
        let arrived = false;
        const arrive = () => {
          if (arrived) return;
          arrived = true;
          if (--waiting === 0) release();
        };
        const DB = {
          prepare: (sql: string) => db.prepare(sql),
          batch: async (...args: Parameters<D1Database["batch"]>) => {
            arrive();
            await released;
            return db.batch(...args);
          },
        } as unknown as D1Database;
        try {
          return await requestGeneration({ ...env(queue().q), DB }, input(siteId));
        } finally {
          arrive();
        }
      }),
    );
  }

  it.each(ROW_STATES)("the site's day at the cap edge: %s", async (_name, state) => {
    // Four of today's rows on s1 that count on any reading: first builds that got the template without a model call.
    for (let i = 0; i < 4; i++) await insertGeneration(db, { id: `d${i}`, site_id: "s1", owner_id: "o1", status: "succeeded", used_fallback: 1, fallback_reason: "budget", created_at: DAY + i, started_at: DAY + i, finished_at: DAY + i });
    await seedRowState("x", "s1", DAY + 10, state);
    expect(await allowance()).toEqual({ generationsLeftToday: state.today ? 0 : 1, generationsLeftTotal: state.total ? 19 : 20 });
    // INSERT_JOB gives the same answer: it refuses exactly when nothing is left today (so a counted queued or running
    // row refuses the request before the one-active index is reached).
    expect(outcome(await requestGeneration(env(queue().q), input()))).toBe(state.today ? "generation_cap_reached" : "regenerate");
  });

  // A row that counts here is refused by requestGeneration's pre-check (OWNER_TOTAL, P3-16 fix 1) before INSERT_JOB
  // runs; the next table checks INSERT_JOB's own count of each row.
  it.each(ROW_STATES)("the owner's total at the cap edge: %s", async (_name, state) => {
    await seedOwnerSite(db, "o1", "s3");
    await succeeded("built", "s1", "first");
    for (let i = 0; i < 19; i++) await succeeded(`r${i}`, "s2", "regenerate");
    await seedRowState("x", "s3", 2, state);
    expect(await allowance()).toEqual({ generationsLeftToday: 5, generationsLeftTotal: state.total ? 0 : 1 });
    expect(outcome(await requestGeneration(env(queue().q), input()))).toBe(state.total ? "generation_cap_reached" : "regenerate");
  });

  // Both requests pass the pre-check (at most 19 counted), so INSERT_JOB alone decides: when the row counts, the second
  // INSERT sees 20 and selects no row; when it does not, both queue.
  it.each(ROW_STATES)("the owner's total in INSERT_JOB itself, two sites at once after both pre-checks: %s", async (_name, state) => {
    await seedOwnerSite(db, "o1", "s3");
    await succeeded("built1", "s1", "first");
    await succeeded("built2", "s2", "first");
    for (let i = 0; i < 18; i++) await succeeded(`r${i}`, "s1", "regenerate");
    await seedRowState("x", "s3", 2, state);
    expect((await allowance()).generationsLeftTotal).toBe(state.total ? 1 : 2);
    const results = await atOnce(["s1", "s2"]);
    expect(results.map(outcome).sort()).toEqual(state.total ? ["generation_cap_reached", "regenerate"] : ["regenerate", "regenerate"]);
    expect((await allowance()).generationsLeftTotal).toBe(0);
  });

  it("counts regenerations that end invalid_output: an owner whose every regeneration ends that way is refused once 20 exist (P3-16 (B))", async () => {
    await succeeded("built", "s1", "first");
    const invalid = (id: string) =>
      insertGeneration(db, { id, site_id: "s2", owner_id: "o1", kind: "regenerate", status: "failed", error_code: "invalid_output", model_slot: 1, attempts: 3, created_at: 1, started_at: 1, finished_at: 1 });
    for (let i = 0; i < 19; i++) await invalid(`v${i}`);
    expect(await allowance()).toEqual({ generationsLeftToday: 5, generationsLeftTotal: 1 });
    await invalid("v19");
    expect(await allowance()).toEqual({ generationsLeftToday: 5, generationsLeftTotal: 0 });
    expect(await requestGeneration(env(queue().q), input())).toEqual({ ok: false, code: "generation_cap_reached" });
  });

  it("counts only the owner's own regenerations: another owner's 20 counted ones neither refuse o1 nor count against o1", async () => {
    await seedOwnerSite(db, "o2", "s9");
    await insertGeneration(db, { id: "o2-built", site_id: "s9", owner_id: "o2", status: "succeeded", created_at: 1 });
    for (let i = 0; i < 20; i++) await insertGeneration(db, { id: `o2-r${i}`, site_id: "s9", owner_id: "o2", kind: "regenerate", status: "succeeded", model_slot: 1, attempts: 1, created_at: 1, started_at: 1, finished_at: 1 });
    const o2 = () => generationAllowance({ DB: db }, { siteId: "s9", ownerId: "o2", now: NOW });
    expect(await o2()).toEqual({ generationsLeftToday: 5, generationsLeftTotal: 0 });
    await succeeded("built", "s1", "first");
    expect(await allowance()).toEqual({ generationsLeftToday: 5, generationsLeftTotal: 20 });
    // o1's regeneration passes the pre-check (OWNER_TOTAL) and INSERT_JOB's own count, and then counts for o1 alone.
    expect(outcome(await requestGeneration(env(queue().q), input()))).toBe("regenerate");
    expect(await allowance()).toEqual({ generationsLeftToday: 4, generationsLeftTotal: 19 });
    expect(await o2()).toEqual({ generationsLeftToday: 5, generationsLeftTotal: 0 });
  });

  it("a failed queue send spends neither count: at the cap edge the next request still queues; the failed row and its audit row stay", async () => {
    await succeeded("built", "s1", "first");
    for (let i = 0; i < 4; i++) await insertGeneration(db, { id: `t${i}`, site_id: "s1", owner_id: "o1", kind: "regenerate", status: "succeeded", model_slot: 1, attempts: 1, created_at: DAY + i, started_at: DAY + i, finished_at: DAY + i });
    for (let i = 0; i < 15; i++) await succeeded(`r${i}`, "s2", "regenerate");
    expect(await allowance()).toEqual({ generationsLeftToday: 1, generationsLeftTotal: 1 });

    expect(await requestGeneration(env(queue(true).q), input())).toEqual({ ok: false, code: "internal" });
    expect(await allowance()).toEqual({ generationsLeftToday: 1, generationsLeftTotal: 1 });
    const failed = await db.prepare("SELECT id, kind, status, error_code, model_slot, started_at FROM generations WHERE error_code = 'internal'").all<{ id: string }>();
    expect(failed.results).toEqual([{ id: expect.any(String), kind: "regenerate", status: "failed", error_code: "internal", model_slot: 0, started_at: null }]);
    const detail = JSON.stringify({ generationId: failed.results[0]?.id ?? "", kind: "regenerate" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE detail_json = ?1").bind(detail).first()).toEqual({ n: 1 });

    expect(outcome(await requestGeneration(env(queue().q), input()))).toBe("regenerate");
    expect(await allowance()).toEqual({ generationsLeftToday: 0, generationsLeftTotal: 0 });
  });

  it("after an outage of failed sends, the site's 5 per UTC day still bites exactly once sends work again", async () => {
    for (let i = 0; i < 6; i++) expect(await requestGeneration(env(queue(true).q), input())).toEqual({ ok: false, code: "internal" });
    expect(await allowance()).toEqual({ generationsLeftToday: 5, generationsLeftTotal: 20 });
    for (let i = 0; i < 5; i++) {
      const result = await requestGeneration(env(queue().q), input());
      expect(outcome(result)).toBe(i === 0 ? "first" : "regenerate");
      if (result.ok) await finishJob(result.generation.id);
    }
    expect(await requestGeneration(env(queue().q), input())).toEqual({ ok: false, code: "generation_cap_reached" });
    expect(await allowance()).toEqual({ generationsLeftToday: 0, generationsLeftTotal: 16 });
    // Every request that wrote a row keeps its audit row: 6 failed sends and 5 queued jobs.
    expect(await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE site_id = 's1'").first()).toEqual({ n: 11 });
  });

  it("after an outage of failed sends, the owner's 20 regenerations still bite exactly once sends work again", async () => {
    await succeeded("built", "s1", "first");
    for (let i = 0; i < 18; i++) await succeeded(`r${i}`, "s2", "regenerate");
    for (let i = 0; i < 4; i++) expect(await requestGeneration(env(queue(true).q), input())).toEqual({ ok: false, code: "internal" });
    expect(await allowance()).toEqual({ generationsLeftToday: 5, generationsLeftTotal: 2 });
    for (let i = 0; i < 2; i++) {
      const result = await requestGeneration(env(queue().q), input());
      expect(outcome(result)).toBe("regenerate");
      if (result.ok) await finishJob(result.generation.id);
    }
    expect(await requestGeneration(env(queue().q), input())).toEqual({ ok: false, code: "generation_cap_reached" });
    expect(await allowance()).toEqual({ generationsLeftToday: 3, generationsLeftTotal: 0 });
  });

  it("stays exact for two sites of one owner at once with 1 left, among regenerations that do not count: exactly one queues", async () => {
    await succeeded("built1", "s1", "first");
    await succeeded("built2", "s2", "first");
    for (let i = 0; i < 19; i++) await succeeded(`r${i}`, i % 2 ? "s1" : "s2", "regenerate");
    const spared = ROW_STATES.filter(([, state]) => state.row.kind === "regenerate" && !state.total);
    for (const [i, [, state]] of spared.entries()) await seedRowState(`n${i}`, i % 2 ? "s1" : "s2", 2, state);
    expect(spared.length).toBeGreaterThan(0);
    expect((await allowance()).generationsLeftTotal).toBe(1);
    const results = await raceTwoSites();
    expect(results.map(outcome).sort()).toEqual(["generation_cap_reached", "regenerate"]);
    expect((await allowance()).generationsLeftTotal).toBe(0);
  });

  // P3-16 item 3 (review mutant M16): the site's daily bound is checked inside INSERT_JOB, so it stays exact when one
  // site gets several requests at once. With 1 left today and no active job, the first INSERT to run writes a queued
  // row, which counts toward the day (COUNTS_TODAY: its error_code is NULL); every later INSERT then selects no row, so
  // each of the others is generation_cap_reached and none reaches the one-active index (generation_in_progress). A daily
  // check made before the INSERT instead lets several requests past it, and all but one then hit the index.
  it("stays exact for five requests at once on one site with 1 left today: one queues, the other four are generation_cap_reached", async () => {
    for (let i = 0; i < 4; i++) await insertGeneration(db, { id: `d${i}`, site_id: "s1", owner_id: "o1", status: "succeeded", used_fallback: 1, fallback_reason: "budget", created_at: DAY + i, started_at: DAY + i, finished_at: DAY + i });
    expect(await allowance()).toEqual({ generationsLeftToday: 1, generationsLeftTotal: 20 });
    const results = await Promise.all(Array.from({ length: 5 }, () => requestGeneration(env(queue().q), input())));
    expect(results.map(outcome).sort()).toEqual(["generation_cap_reached", "generation_cap_reached", "generation_cap_reached", "generation_cap_reached", "regenerate"]);
    expect(await allowance()).toEqual({ generationsLeftToday: 0, generationsLeftTotal: 19 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE site_id = 's1'").first()).toEqual({ n: 1 });
  });
});
