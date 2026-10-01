import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { LIMITS, type GenerationRow } from "@asksite/core";
import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dailyModelLimit, isGenerationEnabled, modelCallsToday, utcDayStart } from "../src/settings.ts";
import { toGenerationView } from "../src/view.ts";
import { clearTables, insertGeneration, LOCAL_D1_WORKER, seedOwnerSite, setSetting, startLocalD1, type LocalD1 } from "./support/d1.ts";

let db: D1Database;
let local: LocalD1 | undefined;
beforeAll(async () => {
  local = startLocalD1(); // before the await: afterAll can close workerd even if this hook times out
  db = await local.ready;
}, 120_000);
afterAll(async () => local?.close());
beforeEach(async () => clearTables(db));

describe("isGenerationEnabled", () => {
  it("is on only when the variable is exactly \"true\" and the setting is not \"false\"", async () => {
    expect(await isGenerationEnabled({ DB: db, GENERATION_ENABLED: "true" })).toBe(true);
    expect(await isGenerationEnabled({ DB: db, GENERATION_ENABLED: "TRUE" })).toBe(false);
    expect(await isGenerationEnabled({ DB: db, GENERATION_ENABLED: "false" })).toBe(false);
    await setSetting(db, "generation.enabled", "false");
    expect(await isGenerationEnabled({ DB: db, GENERATION_ENABLED: "true" })).toBe(false);
    await setSetting(db, "generation.enabled", "true");
    expect(await isGenerationEnabled({ DB: db, GENERATION_ENABLED: "false" })).toBe(false);
  });
});

describe("dailyModelLimit", () => {
  const CONFIG_ERROR = JSON.stringify({ event: "generation.config_error", setting: "DAILY_MODEL_LIMIT" });
  let logged: string[] = [];
  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void logged.push(String(line)));
  });
  afterEach(() => vi.restoreAllMocks());

  it("uses the setting, else the variable; malformed values are skipped and a valid one logs nothing", async () => {
    expect(await dailyModelLimit({ DB: db, DAILY_MODEL_LIMIT: "12" })).toBe(12);
    expect(await dailyModelLimit({ DB: db, DAILY_MODEL_LIMIT: "5" })).toBe(5);
    expect(await dailyModelLimit({ DB: db, DAILY_MODEL_LIMIT: "0" })).toBe(0);
    expect(await dailyModelLimit({ DB: db, DAILY_MODEL_LIMIT: "8" })).toBe(8);
    await setSetting(db, "generation.daily_model_limit", "0");
    expect(await dailyModelLimit({ DB: db, DAILY_MODEL_LIMIT: "12" })).toBe(0);
    await setSetting(db, "generation.daily_model_limit", "-1");
    expect(await dailyModelLimit({ DB: db, DAILY_MODEL_LIMIT: "12" })).toBe(12);
    expect(logged).toEqual([]);
  });

  it("the setting row wins over the variable, even over a malformed variable, with no log line", async () => {
    await setSetting(db, "generation.daily_model_limit", "3");
    expect(await dailyModelLimit({ DB: db, DAILY_MODEL_LIMIT: "12" })).toBe(3);
    expect(await dailyModelLimit({ DB: db, DAILY_MODEL_LIMIT: "eight" })).toBe(3);
    expect(logged).toEqual([]);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["padded left", " 8"],
    ["padded right", "8 "],
    ["negative", "-8"],
    ["decimal", "8.0"],
    ["text", "eight"],
  ])("a %s variable with no setting gives LIMITS.defaultDailyModelLimit (8) and exactly one fixed config_error line", async (_name, value) => {
    expect(LIMITS.defaultDailyModelLimit).toBe(8);
    expect(await dailyModelLimit({ DB: db, DAILY_MODEL_LIMIT: value as string })).toBe(8);
    expect(logged).toEqual([CONFIG_ERROR]);
  });

  it("a malformed setting row and a malformed variable also give 8 with one line, never echoing either value", async () => {
    await setSetting(db, "generation.daily_model_limit", "secret-setting-marker");
    expect(await dailyModelLimit({ DB: db, DAILY_MODEL_LIMIT: "secret-var-marker" })).toBe(8);
    expect(logged).toEqual([CONFIG_ERROR]);
    expect(logged.join("")).not.toMatch(/marker/);
  });
});

describe("modelCallsToday", () => {
  it("counts jobs that took a model slot since 00:00 UTC", async () => {
    const now = Date.UTC(2026, 8, 24, 15);
    await seedOwnerSite(db, "o1", "s1");
    await insertGeneration(db, { id: "a", site_id: "s1", owner_id: "o1", status: "succeeded", model_slot: 1, started_at: utcDayStart(now) });
    await insertGeneration(db, { id: "b", site_id: "s1", owner_id: "o1", status: "succeeded", model_slot: 1, started_at: utcDayStart(now) - 1 });
    await insertGeneration(db, { id: "c", site_id: "s1", owner_id: "o1", status: "succeeded", model_slot: 0, started_at: now });
    expect(utcDayStart(now)).toBe(Date.UTC(2026, 8, 24));
    expect(await modelCallsToday(db, now)).toBe(1);
  });
});

describe("toGenerationView", () => {
  const row: GenerationRow = {
    id: "g", site_id: "s", owner_id: "o", kind: "first", status: "succeeded", input_json: "{}", output_json: "{}",
    used_fallback: 1, fallback_reason: "budget", model_slot: 0, provider: null, model: null, attempts: 0,
    input_tokens: 0, output_tokens: 0, cost_microusd: 0, error_code: null, created_at: 5, started_at: 6, finished_at: 7,
  };

  it("maps the row to the owner-facing view", () => {
    expect(toGenerationView(row)).toEqual({ id: "g", kind: "first", status: "succeeded", createdAt: 5, finishedAt: 7, errorCode: null, usedFallback: true, fallbackReason: "budget" });
  });

  it("never passes an unknown value through", () => {
    expect(toGenerationView({ ...row, status: "failed", error_code: "boom", fallback_reason: "x", used_fallback: 0 })).toMatchObject({ errorCode: "internal", fallbackReason: null, usedFallback: false });
    expect(toGenerationView({ ...row, status: "weird" as GenerationRow["status"], kind: "odd" as GenerationRow["kind"] })).toMatchObject({ status: "failed", kind: "first" });
  });
});

// Task 9 follow-up item 4: each workerd test file's beforeAll starts the harness and then awaits it. When a hook timeout
// ends that wait, vitest runs afterAll with only what startLocalD1 has already handed back; without a closer by then,
// workerd outlives the run. This test is that sequence, with the timeout struck while workerd is starting.
describe("startLocalD1 (test/support/d1.ts)", () => {
  /** workerd processes whose parent is this test process: vitest's default pool runs each test file in its own process. */
  const workerdChildren = (): number[] =>
    execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" })
      .split("\n")
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        return match !== null && Number(match[2]) === process.pid && basename(match[3]!.trim()) === "workerd" ? [Number(match[1])] : [];
      });
  /** Whether the process exists: signal 0 only checks (kill -0), it stops nothing. */
  const running = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  /** Reads every 100 ms until `done` holds or `ms` have passed, and returns the last value read. */
  const waitFor = async <T>(read: () => T, done: (value: T) => boolean, ms: number): Promise<T> => {
    const until = Date.now() + ms;
    for (let value = read(); ; value = read()) {
      if (done(value) || Date.now() > until) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  it("hands back its closer before workerd is ready, so an afterAll stops every workerd it started even when the beforeAll timed out", async () => {
    const fileHarness = new Set(workerdChildren()); // this file's own harness, started in beforeAll
    const started = () => workerdChildren().filter((pid) => !fileHarness.has(pid));
    const harness = startLocalD1(); // the beforeAll's first step; its wait for workerd is what times out
    const seen = await waitFor(started, (pids) => pids.length > 0, 60_000);
    // The hook timed out: afterAll calls the closer it was handed.
    const closed = await Promise.resolve()
      .then(() => harness.close())
      .then(() => "closed", (error: unknown) => String(error));
    const left = await waitFor(started, (pids) => pids.length === 0, 30_000);
    expect({ started: seen.length > 0, closed, stillRunning: seen.filter(running), left }).toEqual({ started: true, closed: "closed", stillRunning: [], left: [] });
  }, 120_000);

  // Global constraint K (A13), as every other harness config asserts it (Task 10 follow-up item 8).
  it("runs its Worker with Node.js compatibility off: both opt-out flags, and no flag starting with nodejs", () => {
    expect(LOCAL_D1_WORKER.compatibility_flags).toEqual(expect.arrayContaining(["no_nodejs_compat", "no_nodejs_compat_v2"]));
    expect(LOCAL_D1_WORKER.compatibility_flags.filter((flag) => flag.startsWith("nodejs"))).toEqual([]);
  });
});
