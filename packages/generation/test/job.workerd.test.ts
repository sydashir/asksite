import { AiDraft, type GenerationInputSnapshot, type GenerationJob, type GenerationRow } from "@asksite/core";
import { SiteDocument } from "@asksite/site-schema";
import type { D1Database, Queue } from "@cloudflare/workers-types";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { capsSnapshot } from "../eval/caps.ts";
import { runGenerationJob, type JobDeps, type JobEnv, type JobReport } from "../src/job.ts";
import { createProvider } from "../src/providers/create.ts";
import type { ModelProvider } from "../src/provider.ts";
import { generationAllowance, requestGeneration } from "../src/request.ts";
import { modelCallsToday } from "../src/settings.ts";
import { templateDraft } from "../src/template.ts";
import { clearTables, getGeneration, insertGeneration, seedOwnerSite, setSetting, startLocalD1 } from "./support/d1.ts";
import { FULL_SNAPSHOT } from "./support/samples.ts";
import { answer, scriptedProvider } from "./support/scripted.ts";

const NOW = Date.UTC(2026, 8, 24, 15);
const INPUT = JSON.stringify(FULL_SNAPSHOT);
const TEMPLATE = templateDraft(FULL_SNAPSHOT.facts, FULL_SNAPSHOT.brief);

let db: D1Database;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await startLocalD1()), 120_000);
afterAll(async () => close());
beforeEach(async () => {
  await clearTables(db);
  await seedOwnerSite(db, "o1", "s1");
  await seedOwnerSite(db, "o1", "s2");
});

// Global constraint L: some tests call the real createProvider for a non-fake provider. No test in this file may reach
// the network, even when a mutant builds a real adapter: the SDK takes the global fetch when it is given none, and this
// global fails loudly instead. The local D1 is unaffected: Miniflare reaches workerd through its own undici fetch.
const globalFetchCalls: unknown[] = [];
beforeEach(() => {
  globalFetchCalls.length = 0;
  vi.stubGlobal("fetch", async (...args: unknown[]) => {
    globalFetchCalls.push(args);
    throw new TypeError("the global fetch must not be used");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(globalFetchCalls).toEqual([]);
});

const envWith = (over: Partial<JobEnv> = {}): JobEnv => ({
  DB: db, GENERATION_ENABLED: "true", DAILY_MODEL_LIMIT: "30", ENVIRONMENT: "development", MODEL_PROVIDER: "fake", MODEL_ID: "fake-template", FAKE_MODE: "ok", ...over,
});
const deps = (provider?: ModelProvider): JobDeps => ({
  now: () => NOW,
  generate: { sleep: async () => {}, timeoutSignal: () => new AbortController().signal, now: () => NOW },
  createProvider: provider === undefined ? createProvider : () => provider,
});
const queued = (id: string, kind: "first" | "regenerate" = "first", site = "s1", input = INPUT) =>
  insertGeneration(db, { id, site_id: site, owner_id: "o1", kind, status: "queued", input_json: input, created_at: NOW - 1000 });

/** U+FDFA: 3 UTF-8 bytes, 33 after NFKC, so the input guard (generate.ts inputBound) counts it as 33. */
const FDFA = String.fromCharCode(0xfdfa);
/** U+1F600: one code point, two UTF-16 units. */
const EMOJI = String.fromCodePoint(0x1f600);
/** Schema-valid owner text over the input bound: every capped field filled with U+FDFA (the P3-8 tests in generate.test.ts). */
const OVER_BOUND = capsSnapshot(FDFA);
/**
 * The P3-8 attempt-2 construction (generate.test.ts): 20 faq entries whose unknown keys repeat `fill`. Zod's
 * "Unrecognized key" message repeats each key, so the model's own text reaches attempt 2's repair lines.
 */
const withUnknownKeys = (draft: AiDraft, fill: string) => ({
  ...draft,
  copy: { ...draft.copy, faq: Array.from({ length: 20 }, (_, i) => ({ question: "Do you fix leaks?", answer: "Yes, we do.", [fill.repeat(300) + String(i)]: "x" })) },
});
/**
 * An answer whose json is a revoked Proxy: checking it throws a TypeError in our own validator, so generateDraft rejects
 * after the call was sent. It proves the rule, not a production path (P3-7c's technique): no JSON parser returns one,
 * but the provider contract (json: unknown) allows it.
 */
const answerOurCodeCannotCheck = () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return answer(proxy);
};

describe("runGenerationJob", () => {
  it("claims the job with a model slot and stores the validated draft", async () => {
    await queued("g1");
    expect(await runGenerationJob(envWith(), "g1", deps())).toMatchObject({ outcome: "succeeded", attempts: 1, usedFallback: false });
    const row = await getGeneration(db, "g1");
    expect(row).toMatchObject({ status: "succeeded", model_slot: 1, started_at: NOW, finished_at: NOW, used_fallback: 0, fallback_reason: null, error_code: null, provider: "fake", model: "fake-template", attempts: 1, cost_microusd: 0 });
    expect(row.input_tokens).toBeGreaterThan(0);
    const draft = AiDraft.parse(JSON.parse(row.output_json!));
    expect(draft).toEqual(TEMPLATE);
    expect(SiteDocument.safeParse({ facts: FULL_SNAPSHOT.facts, ...draft, hidden: [] }).success).toBe(true);
  });

  it("does nothing for a job that is not queued (duplicate or late delivery, or unknown id)", async () => {
    await insertGeneration(db, { id: "g1", site_id: "s1", owner_id: "o1", status: "running", input_json: INPUT, started_at: 1 });
    expect(await runGenerationJob(envWith(), "g1", deps())).toMatchObject({ outcome: "not_claimed" });
    expect(await runGenerationJob(envWith(), "nope", deps())).toMatchObject({ outcome: "not_claimed" });
    expect(await getGeneration(db, "g1")).toMatchObject({ status: "running", started_at: 1 });
  });

  it("lets exactly one of two concurrent deliveries run the job", async () => {
    await queued("g1");
    const outcomes = await Promise.all([runGenerationJob(envWith(), "g1", deps()), runGenerationJob(envWith(), "g1", deps())]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["not_claimed", "succeeded"]);
  });

  it("records the price of every attempt's tokens", async () => {
    await queued("g1");
    const provider = scriptedProvider([answer({}, { inputTokens: 1000, outputTokens: 100 }), answer(TEMPLATE, { inputTokens: 1100, outputTokens: 900 })]);
    await runGenerationJob(envWith({ MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-opus-5-5" }), "g1", deps(provider));
    expect(await getGeneration(db, "g1")).toMatchObject({ status: "succeeded", provider: "anthropic", model: "scripted-1", attempts: 2, input_tokens: 2100, output_tokens: 1000, cost_microusd: 2100 * 4 + 1000 * 20 });
  });

  describe("with no model call allowed", () => {
    it.each([
      ["the variable is off", { GENERATION_ENABLED: "false" }, null, "disabled", "generation_disabled"],
      ["the setting is off", {}, ["generation.enabled", "false"], "disabled", "generation_disabled"],
      ["today's limit is used up", {}, ["generation.daily_model_limit", "0"], "budget", "budget_exhausted"],
    ] as const)("when %s: a first build gets the template, a regeneration fails", async (_, over, setting, reason, code) => {
      if (setting) await setSetting(db, setting[0], setting[1]);
      await queued("f");
      await queued("r", "regenerate", "s2");
      const neverCalled = scriptedProvider([]);
      await runGenerationJob(envWith(over), "f", deps(neverCalled));
      await runGenerationJob(envWith(over), "r", deps(neverCalled));
      expect(neverCalled.requests).toHaveLength(0);
      const first = await getGeneration(db, "f");
      expect(first).toMatchObject({ status: "succeeded", used_fallback: 1, fallback_reason: reason, model_slot: 0, attempts: 0, provider: null });
      expect(AiDraft.parse(JSON.parse(first.output_json!))).toEqual(TEMPLATE);
      expect(await getGeneration(db, "r")).toMatchObject({ status: "failed", error_code: code, model_slot: 0, output_json: null });
    });
  });

  it("hands out exactly the daily limit of model slots under concurrency", async () => {
    await queued("a", "first", "s1");
    await queued("b", "first", "s2");
    await Promise.all([runGenerationJob(envWith({ DAILY_MODEL_LIMIT: "1" }), "a", deps()), runGenerationJob(envWith({ DAILY_MODEL_LIMIT: "1" }), "b", deps())]);
    const slots = [(await getGeneration(db, "a")).model_slot, (await getGeneration(db, "b")).model_slot].sort();
    expect(slots).toEqual([0, 1]);
  });

  // The claim is the exact check of the daily model limit (request.ts only advises) and keeps its own copy of
  // modelCallsToday's count: jobs of any owner holding a model slot, started since 00:00 UTC of the claim (design 6.3
  // step 1). With a limit of 1, one earlier job decides whether the next one gets the day's only model call.
  describe("counts today's model calls from 00:00 UTC, as modelCallsToday does (a limit of 1)", () => {
    const DAY_START = Date.UTC(2026, 8, 24); // 00:00 UTC of NOW's day
    const TAKEN = { status: "succeeded", model_slot: 1, used_fallback: 0, fallback_reason: null, attempts: 1 };
    const REFUSED = { status: "succeeded", model_slot: 0, used_fallback: 1, fallback_reason: "budget", attempts: 0 };
    const limitOne = (over: Partial<JobEnv> = {}) => envWith({ DAILY_MODEL_LIMIT: "1", ...over });

    it.each([
      ["a slot taken an hour earlier today uses it up", 1, NOW - 3_600_000, true],
      ["a slot taken at exactly 00:00 UTC today uses it up", 1, DAY_START, true],
      ["a slot taken 1 ms before 00:00 UTC (yesterday) does not", 1, DAY_START - 1, false],
      ["a job started earlier today without a slot (given back or never taken) does not", 0, NOW - 60_000, false],
    ] as const)("%s", async (_name, modelSlot, startedAt, counted) => {
      await seedOwnerSite(db, "o2", "s3");
      await insertGeneration(db, { id: "earlier", site_id: "s3", owner_id: "o2", status: "succeeded", input_json: INPUT, created_at: startedAt - 1, started_at: startedAt, finished_at: startedAt, model_slot: modelSlot });
      expect(await modelCallsToday(db, NOW)).toBe(counted ? 1 : 0);
      await queued("g");
      await runGenerationJob(limitOne(), "g", deps());
      expect(await getGeneration(db, "g")).toMatchObject(counted ? REFUSED : TAKEN);
    });

    // Which rows count: every job that kept its slot, of either kind and whatever its end. A kept slot may have paid for
    // calls, and a first build is never refused at request time (request.ts), so only this count stops it from going
    // over the limit. Each earlier job here is run by the job itself, on another site.
    it.each<[string, "first" | "regenerate", Partial<JobEnv>, (() => ModelProvider) | undefined, Partial<GenerationRow>]>([
      ["a regeneration that succeeded", "regenerate", {}, undefined, { status: "succeeded", error_code: null }],
      ["a regeneration that failed after three invalid answers", "regenerate", { FAKE_MODE: "invalid-always" }, undefined, { status: "failed", error_code: "invalid_output" }],
      ["a regeneration that failed after three timeouts", "regenerate", { FAKE_MODE: "timeout" }, undefined, { status: "failed", error_code: "provider_timeout" }],
      ["a regeneration that failed after three provider errors", "regenerate", { FAKE_MODE: "error" }, undefined, { status: "failed", error_code: "provider_unavailable" }],
      ["a regeneration that failed when our own code threw after a call (costUnknown)", "regenerate", {}, () => scriptedProvider([answerOurCodeCannotCheck()]), { status: "failed", error_code: "internal" }],
      ["a first build that fell back to the template after three timeouts", "first", { FAKE_MODE: "timeout" }, undefined, { status: "succeeded", used_fallback: 1, fallback_reason: "provider_error" }],
    ])("the slot kept by %s uses it up", async (_name, kind, over, provider, ended) => {
      await queued("earlier", kind, "s2");
      await runGenerationJob(limitOne(over), "earlier", deps(provider?.()));
      expect(await getGeneration(db, "earlier")).toMatchObject({ kind, model_slot: 1, started_at: NOW, ...ended });
      expect(await modelCallsToday(db, NOW)).toBe(1);
      await queued("g");
      await runGenerationJob(limitOne(), "g", deps());
      expect(await getGeneration(db, "g")).toMatchObject(REFUSED);
    });

    it("a job still running with the slot uses it up", async () => {
      await queued("earlier", "regenerate", "s2");
      await queued("g");
      // The next job is claimed while the earlier job's model call is in flight.
      let whileRunning: unknown;
      const inFlight: ModelProvider = {
        id: "fake",
        async generate() {
          whileRunning = await getGeneration(db, "earlier");
          await runGenerationJob(limitOne(), "g", deps());
          return answer(TEMPLATE);
        },
      };
      await runGenerationJob(limitOne(), "earlier", deps(inFlight));
      expect(whileRunning).toMatchObject({ status: "running", model_slot: 1 });
      expect(await getGeneration(db, "g")).toMatchObject(REFUSED);
      expect(await getGeneration(db, "earlier")).toMatchObject({ status: "succeeded", model_slot: 1, attempts: 1 });
    });

    it("a slot given back by a job with no key goes to the next job, which uses it up", async () => {
      await queued("f");
      await queued("g", "first", "s2");
      // "auth" shows f claimed the slot (without one it would not build a provider), then gave it back: no call was sent.
      expect(await runGenerationJob(limitOne({ MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-opus-5-5" }), "f", deps())).toMatchObject({ outcome: "fallback", providerErrorKind: "auth" });
      expect(await getGeneration(db, "f")).toMatchObject({ model_slot: 0, started_at: NOW, attempts: 0 });
      await runGenerationJob(limitOne(), "g", deps());
      expect(await getGeneration(db, "g")).toMatchObject(TAKEN);
      await queued("h"); // s1 again: f has finished
      await runGenerationJob(limitOne(), "h", deps());
      expect(await getGeneration(db, "h")).toMatchObject(REFUSED);
    });
  });

  it.each([
    ["timeout", "provider_error", "provider_timeout"],
    ["error", "provider_error", "provider_unavailable"],
    ["invalid-always", "invalid_output", "invalid_output"],
  ] as const)("FAKE_MODE %s: a first build gets the template (%s), a regeneration fails (%s)", async (mode, reason, code) => {
    await queued("f");
    await queued("r", "regenerate", "s2");
    await runGenerationJob(envWith({ FAKE_MODE: mode }), "f", deps());
    await runGenerationJob(envWith({ FAKE_MODE: mode }), "r", deps());
    expect(await getGeneration(db, "f")).toMatchObject({ status: "succeeded", used_fallback: 1, fallback_reason: reason, attempts: 3, provider: "fake" });
    expect(await getGeneration(db, "r")).toMatchObject({ status: "failed", error_code: code, attempts: 3, output_json: null });
  });

  it("FAKE_MODE invalid-once: repairs on the second attempt", async () => {
    await queued("g1");
    await runGenerationJob(envWith({ FAKE_MODE: "invalid-once" }), "g1", deps());
    expect(await getGeneration(db, "g1")).toMatchObject({ status: "succeeded", used_fallback: 0, attempts: 2 });
  });

  it("treats a missing key as a provider failure, reports it as auth and gives the model slot back", async () => {
    await queued("f");
    await queued("r", "regenerate", "s2");
    const env = envWith({ MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-opus-5-5" });
    expect(await runGenerationJob(env, "f", deps())).toMatchObject({ outcome: "fallback", providerErrorKind: "auth", attemptOutcomes: [] });
    expect(await runGenerationJob(env, "r", deps())).toMatchObject({ outcome: "failed", providerErrorKind: "auth", attemptOutcomes: [] });
    expect(await getGeneration(db, "f")).toMatchObject({ status: "succeeded", used_fallback: 1, fallback_reason: "provider_error", attempts: 0, model_slot: 0 });
    expect(await getGeneration(db, "r")).toMatchObject({ status: "failed", error_code: "provider_unavailable", attempts: 0, model_slot: 0 });
  });

  it("reports each attempt's outcome, the provider error kind and the duration for the log line", async () => {
    await queued("g1");
    let clock = NOW;
    const ticking: JobDeps = { ...deps(), now: () => (clock += 1000) };
    expect(await runGenerationJob(envWith({ FAKE_MODE: "timeout" }), "g1", ticking)).toMatchObject({
      outcome: "fallback", attempts: 3, providerErrorKind: "timeout", attemptOutcomes: ["timeout", "timeout", "timeout"], durationMs: 2000,
    });
    expect(await getGeneration(db, "g1")).toMatchObject({ model_slot: 1, attempts: 3 });
  });

  it("still gives a first build the template when something unexpected throws; a regeneration fails with internal", async () => {
    await queued("f");
    await queued("r", "regenerate", "s2");
    const broken: JobDeps = { ...deps(), createProvider: () => { throw new TypeError("bug"); } };
    expect(await runGenerationJob(envWith(), "f", broken)).toMatchObject({ outcome: "fallback", fallbackReason: "provider_error" });
    expect(await runGenerationJob(envWith(), "r", broken)).toMatchObject({ outcome: "failed", errorCode: "internal" });
    const first = await getGeneration(db, "f");
    expect(first).toMatchObject({ status: "succeeded", used_fallback: 1, fallback_reason: "provider_error" });
    expect(AiDraft.parse(JSON.parse(first.output_json!))).toEqual(TEMPLATE);
  });

  it("leaves a claimed row it cannot read to the sweeper, without throwing", async () => {
    await queued("g1");
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          if (sql.startsWith("SELECT kind")) throw new Error("D1 down");
          return target.prepare(sql);
        };
      },
    });
    await expect(runGenerationJob(envWith({ DB: flaky }), "g1", deps())).resolves.toMatchObject({ outcome: "read_failed" });
    expect(await getGeneration(db, "g1")).toMatchObject({ status: "running", started_at: NOW });
  });

  it("fails a job whose stored input is not a valid snapshot", async () => {
    await insertGeneration(db, { id: "g1", site_id: "s1", owner_id: "o1", status: "queued", input_json: '{"facts":{}}', created_at: NOW });
    expect(await runGenerationJob(envWith(), "g1", deps())).toMatchObject({ outcome: "failed", errorCode: "internal" });
    expect(await getGeneration(db, "g1")).toMatchObject({ status: "failed", error_code: "internal" });
  });

  it("never overwrites a row the sweeper finished first", async () => {
    await queued("g1");
    const slow: ModelProvider = {
      id: "fake",
      async generate() {
        await db.prepare("UPDATE generations SET status = 'succeeded', used_fallback = 1, fallback_reason = 'provider_error' WHERE id = 'g1'").run();
        return answer(TEMPLATE);
      },
    };
    expect(await runGenerationJob(envWith(), "g1", deps(slow))).toMatchObject({ outcome: "lost" });
    expect(await getGeneration(db, "g1")).toMatchObject({ status: "succeeded", used_fallback: 1, fallback_reason: "provider_error" });
  });

  it("never throws after the claim, even if the final write fails", async () => {
    await queued("g1");
    let calls = 0;
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          calls += 1;
          if (sql.includes("finished_at = ?")) throw new Error("D1 down");
          return target.prepare(sql);
        };
      },
    });
    await expect(runGenerationJob(envWith({ DB: flaky }), "g1", deps())).resolves.toMatchObject({ outcome: "write_failed" });
    expect(calls).toBeGreaterThan(0);
  });

  it("reports the whole outcome for the log line, with every flag false when nothing went wrong (task-9-additions A)", async () => {
    await queued("g1");
    expect(await runGenerationJob(envWith(), "g1", deps())).toEqual({
      outcome: "succeeded",
      generationId: "g1",
      attempts: 1,
      usedFallback: false,
      errorCode: null,
      fallbackReason: null,
      providerErrorKind: null,
      attemptOutcomes: ["valid"],
      usageMissing: false,
      inputBoundRefused: false,
      costUnknown: false,
      durationMs: 0,
    });
  });

  // Task 9 follow-up item 6 (task-9-additions A): the Worker's log line spreads the report, so the whole report is pinned
  // on every path the job has. usageMissing, inputBoundRefused and costUnknown are booleans on each, never undefined.
  describe("reports the whole outcome on every path", () => {
    const REPORT = {
      generationId: "g1", attempts: 0, usedFallback: false, errorCode: null, fallbackReason: null, providerErrorKind: null,
      attemptOutcomes: [], usageMissing: false, inputBoundRefused: false, costUnknown: false, durationMs: 0,
    };
    const ANTHROPIC = { MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-opus-5-5" };
    const TIMEOUTS: JobReport["attemptOutcomes"] = ["timeout", "timeout", "timeout"];
    /** The test's D1 binding, whose prepare throws for the statements `failing` picks. */
    const failingDb = (failing: (sql: string) => boolean) =>
      new Proxy(db, {
        get(target, prop, receiver) {
          if (prop !== "prepare") return Reflect.get(target, prop, receiver);
          return (sql: string) => {
            if (failing(sql)) throw new Error("D1 down");
            return target.prepare(sql);
          };
        },
      });
    /** A provider that ends the row itself (as the sweeper would) before it answers. */
    const finishesFirst = (): ModelProvider => ({
      id: "fake",
      async generate() {
        await db.prepare("UPDATE generations SET status = 'succeeded', used_fallback = 1, fallback_reason = 'provider_error' WHERE id = 'g1'").run();
        return answer(TEMPLATE);
      },
    });
    type Path = {
      kind?: "first" | "regenerate";
      input?: string;
      notQueued?: true;
      env?: () => Partial<JobEnv>;
      setting?: [string, string];
      jobDeps?: () => JobDeps;
      report: Partial<JobReport> & Pick<JobReport, "outcome">;
    };

    it.each<[string, Path]>([
      ["success", { report: { outcome: "succeeded", attempts: 1, attemptOutcomes: ["valid"] } }],
      ["success, with the provider's own model string", { env: () => ANTHROPIC, jobDeps: () => deps(scriptedProvider([answer(TEMPLATE)])), report: { outcome: "succeeded", attempts: 1, attemptOutcomes: ["valid"] } }],
      ["success, with a model string over 200 UTF-16 units", { jobDeps: () => deps(scriptedProvider([{ ...answer(TEMPLATE), model: "m".repeat(201) }])), report: { outcome: "succeeded", attempts: 1, attemptOutcomes: ["valid"] } }],
      ["template fallback: a first build after three timeouts (usage unknown)", { env: () => ({ FAKE_MODE: "timeout" }), report: { outcome: "fallback", attempts: 3, usedFallback: true, fallbackReason: "provider_error", providerErrorKind: "timeout", attemptOutcomes: TIMEOUTS, usageMissing: true } }],
      ["a regeneration that failed after three timeouts (usage unknown)", { kind: "regenerate", env: () => ({ FAKE_MODE: "timeout" }), report: { outcome: "failed", attempts: 3, errorCode: "provider_timeout", providerErrorKind: "timeout", attemptOutcomes: TIMEOUTS, usageMissing: true } }],
      ["a regeneration that failed after three invalid answers", { kind: "regenerate", env: () => ({ FAKE_MODE: "invalid-always" }), report: { outcome: "failed", attempts: 3, errorCode: "invalid_output", attemptOutcomes: ["invalid", "invalid", "invalid"] } }],
      ["claim refusal: switched off, a first build gets the template", { env: () => ({ GENERATION_ENABLED: "false" }), report: { outcome: "fallback", usedFallback: true, fallbackReason: "disabled" } }],
      ["claim refusal: today's model calls used up, a regeneration fails", { kind: "regenerate", setting: ["generation.daily_model_limit", "0"], report: { outcome: "failed", errorCode: "budget_exhausted" } }],
      ["provider failure: no key, a first build gets the template", { env: () => ANTHROPIC, report: { outcome: "fallback", usedFallback: true, fallbackReason: "provider_error", providerErrorKind: "auth" } }],
      ["provider failure: no key, a regeneration fails", { kind: "regenerate", env: () => ANTHROPIC, report: { outcome: "failed", errorCode: "provider_unavailable", providerErrorKind: "auth" } }],
      ["provider failure: the input guard refused attempt 1, a regeneration fails", { kind: "regenerate", input: JSON.stringify(OVER_BOUND), jobDeps: () => deps(scriptedProvider([])), report: { outcome: "failed", errorCode: "provider_unavailable", providerErrorKind: "bad_request", attemptOutcomes: ["bad_request"], inputBoundRefused: true } }],
      ["catch-all: our own code threw after a call (costUnknown), a first build gets the template", { env: () => ANTHROPIC, jobDeps: () => deps(scriptedProvider([answerOurCodeCannotCheck()])), report: { outcome: "fallback", usedFallback: true, fallbackReason: "provider_error", costUnknown: true } }],
      ["catch-all: our own code threw after a call (costUnknown), a regeneration fails", { kind: "regenerate", env: () => ANTHROPIC, jobDeps: () => deps(scriptedProvider([answerOurCodeCannotCheck()])), report: { outcome: "failed", errorCode: "internal", costUnknown: true } }],
      ["catch-all: our own code threw before any call, a first build gets the template", { jobDeps: () => ({ ...deps(), createProvider: () => { throw new TypeError("bug"); } }), report: { outcome: "fallback", usedFallback: true, fallbackReason: "provider_error" } }],
      ["the stored input is not a valid snapshot", { input: '{"facts":{}}', report: { outcome: "failed", errorCode: "internal" } }],
      ["not claimed: no queued job", { notQueued: true, report: { outcome: "not_claimed" } }],
      ["read_failed: the claimed row cannot be read", { env: () => ({ DB: failingDb((sql) => sql.startsWith("SELECT kind")) }), report: { outcome: "read_failed" } }],
      ["lost: the row was finished by someone else first", { jobDeps: () => deps(finishesFirst()), report: { outcome: "lost", attempts: 1, attemptOutcomes: ["valid"] } }],
      ["write_failed: the final write failed", { env: () => ({ DB: failingDb((sql) => sql.includes("finished_at = ?")) }), report: { outcome: "write_failed", attempts: 1, attemptOutcomes: ["valid"] } }],
    ])("%s", async (_path, path) => {
      if (path.setting) await setSetting(db, ...path.setting);
      if (!path.notQueued) await queued("g1", path.kind, "s1", path.input);
      const report = await runGenerationJob(envWith(path.env?.()), "g1", path.jobDeps?.() ?? deps());
      expect(report).toEqual({ ...REPORT, ...path.report });
    });
  });

  // Task 9 follow-up item 2: the Worker hands each report to its log line, and a caller may edit it. Each path below
  // made no attempt, so its report's attemptOutcomes is empty: it must be a new array every time.
  it.each<[string, Partial<JobEnv>, (() => JobDeps) | undefined]>([
    ["no model slot (switched off)", { GENERATION_ENABLED: "false" }, undefined],
    ["a provider it cannot build (no key)", { MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-opus-5-5" }, undefined],
    ["our own code threw before any call", {}, () => ({ ...deps(), createProvider: () => { throw new TypeError("bug"); } })],
  ])("gives each report its own attemptOutcomes, so editing one never changes a later job's report: %s", async (_path, over, jobDeps) => {
    await queued("a");
    await queued("b", "first", "s2");
    const first = await runGenerationJob(envWith(over), "a", jobDeps?.() ?? deps());
    expect(first.attemptOutcomes).toEqual([]);
    first.attemptOutcomes.push("valid");
    expect((await runGenerationJob(envWith(over), "b", jobDeps?.() ?? deps())).attemptOutcomes).toEqual([]);
  });

  // P3-4a: an attempt whose usage is unknown (the provider sent none, or a sent call timed out) flags the report.
  it.each([
    ["an answer came without usage", true, {}, () => scriptedProvider([{ ...answer({}), usageMissing: true }, answer(TEMPLATE)])],
    ["every sent call timed out", true, { FAKE_MODE: "timeout" }, undefined],
    ["every answer came with usage", false, {}, () => scriptedProvider([answer({}), answer(TEMPLATE)])],
  ] as const)("reports usageMissing when %s: %s", async (_case, usageMissing, over, provider) => {
    await queued("g1");
    expect(await runGenerationJob(envWith(over), "g1", deps(provider?.()))).toMatchObject({ usageMissing });
  });

  // task-9-additions B: attempts counts only the calls sent, so a job whose every attempt was stopped before its call
  // gives its model slot back; OVER_BOUND makes the input guard refuse attempt 1.
  it("gives the model slot back when the input guard refuses attempt 1: no call is sent, a first build gets the template, a regeneration fails", async () => {
    await queued("f", "first", "s1", JSON.stringify(OVER_BOUND));
    await queued("r", "regenerate", "s2", JSON.stringify(OVER_BOUND));
    const neverCalled = scriptedProvider([]);
    const refused = { attempts: 0, providerErrorKind: "bad_request", attemptOutcomes: ["bad_request"], inputBoundRefused: true, usageMissing: false };
    expect(await runGenerationJob(envWith(), "f", deps(neverCalled))).toMatchObject({ outcome: "fallback", fallbackReason: "provider_error", ...refused });
    expect(await runGenerationJob(envWith(), "r", deps(neverCalled))).toMatchObject({ outcome: "failed", errorCode: "provider_unavailable", ...refused });
    expect(neverCalled.requests).toHaveLength(0);
    const unsent = { attempts: 0, model_slot: 0, input_tokens: 0, output_tokens: 0, cost_microusd: 0, provider: "fake", model: "fake-template" };
    const first = await getGeneration(db, "f");
    expect(first).toMatchObject({ status: "succeeded", used_fallback: 1, fallback_reason: "provider_error", error_code: null, ...unsent });
    expect(AiDraft.parse(JSON.parse(first.output_json!))).toEqual(templateDraft(OVER_BOUND.facts, OVER_BOUND.brief));
    expect(await getGeneration(db, "r")).toMatchObject({ status: "failed", error_code: "provider_unavailable", output_json: null, ...unsent });
  });

  it("gives the model slot back when every attempt's deadline had passed before its call: no call is sent", async () => {
    await queued("f");
    await queued("r", "regenerate", "s2");
    const neverCalled = scriptedProvider([]);
    const expired: JobDeps = { ...deps(neverCalled), generate: { ...deps().generate, timeoutSignal: () => AbortSignal.abort() } };
    const unsent = { attempts: 0, providerErrorKind: "timeout", attemptOutcomes: ["timeout", "timeout", "timeout"], usageMissing: false, inputBoundRefused: false };
    expect(await runGenerationJob(envWith(), "f", expired)).toMatchObject({ outcome: "fallback", fallbackReason: "provider_error", ...unsent });
    expect(await runGenerationJob(envWith(), "r", expired)).toMatchObject({ outcome: "failed", errorCode: "provider_timeout", ...unsent });
    expect(neverCalled.requests).toHaveLength(0);
    expect(await getGeneration(db, "f")).toMatchObject({ status: "succeeded", used_fallback: 1, fallback_reason: "provider_error", attempts: 0, model_slot: 0 });
    expect(await getGeneration(db, "r")).toMatchObject({ status: "failed", error_code: "provider_timeout", attempts: 0, model_slot: 0 });
  });

  it("keeps the model slot when the input guard refuses attempt 2 after attempt 1 was sent", async () => {
    await queued("g1");
    const provider = scriptedProvider([answer(withUnknownKeys(TEMPLATE, FDFA)), answer(TEMPLATE)]);
    expect(await runGenerationJob(envWith(), "g1", deps(provider))).toMatchObject({
      outcome: "fallback",
      fallbackReason: "provider_error",
      attempts: 1,
      providerErrorKind: "bad_request",
      attemptOutcomes: ["invalid", "bad_request"],
      inputBoundRefused: true,
    });
    expect(provider.requests).toHaveLength(1);
    expect(await getGeneration(db, "g1")).toMatchObject({ status: "succeeded", used_fallback: 1, fallback_reason: "provider_error", attempts: 1, model_slot: 1, input_tokens: 100, output_tokens: 50 });
  });

  // task-9-additions C: generateDraft rejects only when our own code throws (a bug), and paid calls may have been sent by
  // then. Decision 24 still holds (a first build gets the template, a regeneration fails with internal), but the job
  // keeps the model slot, records tokens and cost as 0 (unknown) and flags costUnknown.
  it("keeps the model slot and flags the cost as unknown when our own code throws after a call was sent", async () => {
    await queued("f");
    await queued("r", "regenerate", "s2");
    const first = scriptedProvider([answerOurCodeCannotCheck()]);
    const regeneration = scriptedProvider([answerOurCodeCannotCheck()]);
    const unknown = { attempts: 0, costUnknown: true, usageMissing: false, providerErrorKind: null, attemptOutcomes: [] };
    expect(await runGenerationJob(envWith(), "f", deps(first))).toMatchObject({ outcome: "fallback", fallbackReason: "provider_error", ...unknown });
    expect(await runGenerationJob(envWith(), "r", deps(regeneration))).toMatchObject({ outcome: "failed", errorCode: "internal", ...unknown });
    expect([first.requests.length, regeneration.requests.length]).toEqual([1, 1]);
    const kept = { model_slot: 1, attempts: 0, input_tokens: 0, output_tokens: 0, cost_microusd: 0, provider: null, model: null };
    const firstRow = await getGeneration(db, "f");
    expect(firstRow).toMatchObject({ status: "succeeded", used_fallback: 1, fallback_reason: "provider_error", error_code: null, ...kept });
    expect(AiDraft.parse(JSON.parse(firstRow.output_json!))).toEqual(TEMPLATE);
    expect(await getGeneration(db, "r")).toMatchObject({ status: "failed", error_code: "internal", output_json: null, ...kept });
  });

  it("gives the model slot back when our own code throws before any call: nothing was sent, so the cost is known", async () => {
    await queued("f");
    await queued("r", "regenerate", "s2");
    const broken: JobDeps = { ...deps(), createProvider: () => { throw new TypeError("bug"); } };
    expect(await runGenerationJob(envWith(), "f", broken)).toMatchObject({ outcome: "fallback", fallbackReason: "provider_error", attempts: 0, costUnknown: false });
    expect(await runGenerationJob(envWith(), "r", broken)).toMatchObject({ outcome: "failed", errorCode: "internal", attempts: 0, costUnknown: false });
    expect(await getGeneration(db, "f")).toMatchObject({ status: "succeeded", used_fallback: 1, fallback_reason: "provider_error", attempts: 0, model_slot: 0 });
    expect(await getGeneration(db, "r")).toMatchObject({ status: "failed", error_code: "internal", attempts: 0, model_slot: 0 });
  });

  // task-9-additions E: the provider's model string is unbounded provider text. The job stores it (Task 12 logs the
  // stored value) only when it is a string of 1 to 200 UTF-16 units (JavaScript's length), else the requested id.
  it.each([
    ["a normal model string: kept", "scripted-1", "scripted-1"],
    ["200 UTF-16 units: kept", "m".repeat(200), "m".repeat(200)],
    ["201 UTF-16 units: the requested id", "m".repeat(201), "fake-template"],
    ["100 emoji, 200 UTF-16 units: kept", EMOJI.repeat(100), EMOJI.repeat(100)],
    ["101 emoji, 202 UTF-16 units but 101 code points: the requested id", EMOJI.repeat(101), "fake-template"],
    ["empty: the requested id", "", "fake-template"],
    ["not a string (a number): the requested id", 42, "fake-template"],
    ["not a string (an array with a length of 1): the requested id", ["scripted-1"], "fake-template"],
  ] as const)("stores the provider's model string only when it is 1 to 200 UTF-16 units: %s", async (_case, model, stored) => {
    await queued("g1");
    const provider = scriptedProvider([{ ...answer(TEMPLATE), model: model as unknown as string }]);
    await runGenerationJob(envWith(), "g1", deps(provider));
    expect(await getGeneration(db, "g1")).toMatchObject({ status: "succeeded", model: stored });
  });
});

// task-9-additions F: requestGeneration queues a regeneration (the site already has a draft), the job ends it, and
// generationAllowance before the request and after the job shows whether that end-state counts toward the owner's 20
// (request.ts COUNTS_TOWARD_TOTAL): it counts once it succeeded or failed with invalid_output, never after any other
// failure. A model slot the job kept still counts toward today's model limit, which bounds even an unknown cost.
describe("the job's end-states and the owner's lifetime total, end to end (task-9-additions F)", () => {
  const GEN_QUEUE = { send: async () => {} } as unknown as Queue<GenerationJob>;
  const allowance = () => generationAllowance({ DB: db }, { siteId: "s1", ownerId: "o1", now: NOW });
  type EndState = { snapshot?: GenerationInputSnapshot; env?: Partial<JobEnv>; setting?: [string, string]; provider?: () => ModelProvider; row: Partial<GenerationRow>; counted: boolean };

  it.each<[string, EndState]>([
    ["refused at claim time: generation is switched off", { env: { GENERATION_ENABLED: "false" }, row: { status: "failed", error_code: "generation_disabled", attempts: 0, model_slot: 0 }, counted: false }],
    ["refused at claim time: today's model calls are used up", { setting: ["generation.daily_model_limit", "0"], row: { status: "failed", error_code: "budget_exhausted", attempts: 0, model_slot: 0 }, counted: false }],
    ["refused at claim time: no key", { env: { MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-opus-5-5" }, row: { status: "failed", error_code: "provider_unavailable", attempts: 0, model_slot: 0 }, counted: false }],
    ["the input guard refused attempt 1", { snapshot: OVER_BOUND, provider: () => scriptedProvider([]), row: { status: "failed", error_code: "provider_unavailable", attempts: 0, model_slot: 0 }, counted: false }],
    ["our own code threw after a call was sent (costUnknown)", { provider: () => scriptedProvider([answerOurCodeCannotCheck()]), row: { status: "failed", error_code: "internal", attempts: 0, model_slot: 1 }, counted: false }],
    ["three invalid answers", { env: { FAKE_MODE: "invalid-always" }, row: { status: "failed", error_code: "invalid_output", attempts: 3, model_slot: 1 }, counted: true }],
    ["a valid answer", { row: { status: "succeeded", error_code: null, attempts: 1, model_slot: 1 }, counted: true }],
  ])("%s", async (_name, end) => {
    // The site's first build succeeded long ago, so the next request is a regeneration.
    await insertGeneration(db, { id: "built", site_id: "s1", owner_id: "o1", status: "succeeded", created_at: 1, started_at: 1, finished_at: 1 });
    expect(await allowance()).toEqual({ generationsLeftToday: 5, generationsLeftTotal: 20 });
    const request = await requestGeneration({ DB: db, GEN_QUEUE, GENERATION_ENABLED: "true", DAILY_MODEL_LIMIT: "30" }, { siteId: "s1", ownerId: "o1", snapshot: end.snapshot ?? FULL_SNAPSHOT, now: NOW });
    if (!request.ok) throw new Error(`the request was refused: ${request.code}`);
    expect(request.generation.kind).toBe("regenerate");
    // A queued regeneration counts until the job ends it.
    expect(await allowance()).toEqual({ generationsLeftToday: 4, generationsLeftTotal: 19 });
    if (end.setting) await setSetting(db, ...end.setting);
    await runGenerationJob(envWith(end.env), request.generation.id, deps(end.provider?.()));
    expect(await getGeneration(db, request.generation.id)).toMatchObject({ kind: "regenerate", ...end.row });
    expect(await modelCallsToday(db, NOW)).toBe(end.row.model_slot);
    expect(await allowance()).toEqual({ generationsLeftToday: 4, generationsLeftTotal: end.counted ? 19 : 20 });
  });
});
