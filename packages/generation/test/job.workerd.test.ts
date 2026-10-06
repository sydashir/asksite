import { AiDraft, Brief, type AiAnswer, type GenerationInputSnapshot, type GenerationJob, type GenerationRow } from "@asksite/core";
import { Facts, SiteDocument, TRADES } from "@asksite/site-schema";
import type { D1Database, Queue } from "@cloudflare/workers-types";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { capsSnapshot } from "../eval/caps.ts";
import { inputBound, MAX_INPUT_TOKENS } from "../src/generate.ts";
import { runGenerationJob, type JobDeps, type JobEnv, type JobReport } from "../src/job.ts";
import { createProvider } from "../src/providers/create.ts";
import type { ModelProvider } from "../src/provider.ts";
import { buildPrompt } from "../src/prompt.ts";
import { generationAllowance, requestGeneration } from "../src/request.ts";
import { modelCallsToday } from "../src/settings.ts";
import { templateAnswer, templateDraft } from "../src/template.ts";
import { AI_DRAFT_JSON_SCHEMA } from "../src/wire-schema.ts";
import { clearTables, failingRuns, getGeneration, insertGeneration, seedOwnerSite, setSetting, startLocalD1, type LocalD1 } from "./support/d1.ts";
import { FULL_SNAPSHOT } from "./support/samples.ts";
import { answer, ProviderError, scriptedProvider } from "./support/scripted.ts";

const NOW = Date.UTC(2026, 8, 24, 15);
const INPUT = JSON.stringify(FULL_SNAPSHOT);
/** The stored template draft, and the template's answer as a model gives it (no design; the job stores it on the trade's). */
const TEMPLATE = templateDraft(FULL_SNAPSHOT.facts, FULL_SNAPSHOT.brief);
const MODEL_ANSWER = templateAnswer(FULL_SNAPSHOT.facts, FULL_SNAPSHOT.brief);

let db: D1Database;
let local: LocalD1 | undefined;
beforeAll(async () => {
  local = startLocalD1(); // before the await: afterAll can close workerd even if this hook times out
  db = await local.ready;
}, 120_000);
afterAll(async () => local?.close());
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
/** The input bound of a snapshot's first attempt, as generateDraft measures it (no repair lines yet). */
const firstBound = (snapshot: GenerationInputSnapshot): number => inputBound({ ...buildPrompt(snapshot), jsonSchema: AI_DRAFT_JSON_SCHEMA });
/**
 * P3-18's attack, built as generate.test.ts builds its edge cases: owner notes sized so attempt 1's bound is exactly
 * MAX_INPUT_TOKENS (each U+FDFA adds 33 NFKC bytes, each "n" 1; the notes stay under their 2,000 cap). Attempt 1 is
 * sent; any answer that is not valid adds repair lines, and the input guard refuses attempt 2.
 */
const AT_BOUND: GenerationInputSnapshot = (() => {
  const withNotes = (notes: string): GenerationInputSnapshot => ({ facts: FULL_SNAPSHOT.facts, brief: Brief.parse({ ...FULL_SNAPSHOT.brief, notes }) });
  const fdfa = FDFA.repeat(Math.floor((MAX_INPUT_TOKENS - firstBound(withNotes("n")) - 40) / 33));
  return withNotes(fdfa + "n".repeat(MAX_INPUT_TOKENS - firstBound(withNotes(fdfa))));
})();
/**
 * The P3-8 attempt-2 construction (generate.test.ts): 20 faq entries whose unknown keys repeat `fill`. Zod's
 * "Unrecognized key" message repeats each key, so the model's own text reaches attempt 2's repair lines.
 */
const withUnknownKeys = (base: AiAnswer, fill: string) => ({
  ...base,
  copy: { ...base.copy, faq: Array.from({ length: 20 }, (_, i) => ({ question: "Do you fix leaks?", answer: "Yes, we do.", [fill.repeat(300) + String(i)]: "x" })) },
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

  // A12 (user decision 2026-09-26): every draft starts on its trade's design, the model's and the template's alike. The
  // stored JSON is read as it is (not through AiDraft, whose default would fill in a missing design).
  it("roofing model and template drafts store refined: every trade's model answer and template fallback store the trade's design", async () => {
    const stored: Record<string, { model: unknown; template: unknown }> = {};
    for (const trade of TRADES) {
      const snapshot = { facts: Facts.parse({ ...FULL_SNAPSHOT.facts, trade }), brief: FULL_SNAPSHOT.brief };
      const modelAnswer = { ...templateAnswer(snapshot.facts, snapshot.brief), theme: { palette: "green-amber", font: "clean" } };
      await queued(`m-${trade}`, "first", "s1", JSON.stringify(snapshot));
      await runGenerationJob(envWith(), `m-${trade}`, deps(scriptedProvider([answer(modelAnswer)])));
      await queued(`t-${trade}`, "first", "s2", JSON.stringify(snapshot));
      await runGenerationJob(envWith({ FAKE_MODE: "error" }), `t-${trade}`, deps());
      const model = await getGeneration(db, `m-${trade}`);
      const template = await getGeneration(db, `t-${trade}`);
      expect(model, trade).toMatchObject({ status: "succeeded", used_fallback: 0 });
      expect(template, trade).toMatchObject({ status: "succeeded", used_fallback: 1, fallback_reason: "provider_error" });
      stored[trade] = { model: JSON.parse(model.output_json!).theme, template: JSON.parse(template.output_json!).theme };
    }
    expect(stored).toEqual({
      plumbing: { model: { palette: "green-amber", font: "clean", design: "impact" }, template: { palette: "navy-orange", font: "clean", design: "impact" } },
      hvac: { model: { palette: "green-amber", font: "clean", design: "impact" }, template: { palette: "blue-yellow", font: "clean", design: "impact" } },
      electrical: { model: { palette: "green-amber", font: "clean", design: "impact" }, template: { palette: "charcoal-red", font: "sturdy", design: "impact" } },
      roofing: { model: { palette: "green-amber", font: "clean", design: "refined" }, template: { palette: "charcoal-red", font: "sturdy", design: "refined" } },
      cleaning: { model: { palette: "green-amber", font: "clean", design: "modern" }, template: { palette: "blue-yellow", font: "friendly", design: "modern" } },
      landscaping: { model: { palette: "green-amber", font: "clean", design: "refined" }, template: { palette: "green-amber", font: "friendly", design: "refined" } },
    });
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
    const provider = scriptedProvider([answer({}, { inputTokens: 1000, outputTokens: 100 }), answer(MODEL_ANSWER, { inputTokens: 1100, outputTokens: 900 })]);
    await runGenerationJob(envWith({ MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-opus-5-5" }), "g1", deps(provider));
    expect(await getGeneration(db, "g1")).toMatchObject({ status: "succeeded", provider: "anthropic", model: "scripted-1", attempts: 2, input_tokens: 2100, output_tokens: 1000, cost_microusd: 2100 * 4 + 1000 * 20 });
  });

  describe("with no model call allowed", () => {
    it.each([
      ["the variable is off", { GENERATION_ENABLED: "false" }, null, "disabled", "generation_disabled"],
      ["the setting is off", {}, ["generation.enabled", "false"], "disabled", "generation_disabled"],
      ["the setting is malformed", {}, ["generation.enabled", "False"], "disabled", "generation_disabled"],
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
          return answer(MODEL_ANSWER);
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

  // parseSnapshot's guards (snapshot.ts), Task 9 follow-up item 5: input that is not JSON, not a valid snapshot, or a
  // snapshot with a key it does not know never reaches the model. The job fails it before any call, without throwing,
  // and gives the model slot back. A first build fails too: without a valid snapshot it has no facts for the template.
  it.each([
    ["not JSON", "{not json"],
    ["not a valid snapshot", '{"facts":{}}'],
    ["a valid snapshot with an unknown key", JSON.stringify({ ...FULL_SNAPSHOT, extra: 1 })],
  ])("fails a job whose stored input is %s, before any call", async (_input, inputJson) => {
    await insertGeneration(db, { id: "g1", site_id: "s1", owner_id: "o1", status: "queued", input_json: inputJson, created_at: NOW });
    const neverCalled = scriptedProvider([]);
    await expect(runGenerationJob(envWith(), "g1", deps(neverCalled))).resolves.toMatchObject({ outcome: "failed", errorCode: "internal", attempts: 0, costUnknown: false });
    expect(neverCalled.requests).toHaveLength(0);
    expect(await getGeneration(db, "g1")).toMatchObject({ status: "failed", error_code: "internal", model_slot: 0, attempts: 0, output_json: null });
  });

  it("never overwrites a row the sweeper finished first", async () => {
    await queued("g1");
    const slow: ModelProvider = {
      id: "fake",
      async generate() {
        await db.prepare("UPDATE generations SET status = 'succeeded', used_fallback = 1, fallback_reason = 'provider_error' WHERE id = 'g1'").run();
        return answer(MODEL_ANSWER);
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
      provider: "fake",
      model: "fake-template",
    });
  });

  // Task 9 follow-up item 6 (task-9-additions A): the Worker's log line spreads the report, so the whole report is pinned
  // on every path the job has. usageMissing, inputBoundRefused and costUnknown are booleans on each, never undefined.
  // Item 1: the report's provider and model are the values the job's final write stored in the row (the model capped as
  // task-9-additions E gives), so Task 12's log lines need no extra D1 read. On lost and write_failed the job's write
  // stored nothing: the report carries the values that write held, as it does for attempts.
  describe("reports the whole outcome on every path", () => {
    const REPORT = {
      generationId: "g1", attempts: 0, usedFallback: false, errorCode: null, fallbackReason: null, providerErrorKind: null,
      attemptOutcomes: [], usageMissing: false, inputBoundRefused: false, costUnknown: false, durationMs: 0, provider: null, model: null,
    };
    const FAKE = { provider: "fake", model: "fake-template" };
    /** Item 3: a costUnknown ending stores the configured provider and the requested model, not the scripted answer's. */
    const REQUESTED = { provider: "anthropic", model: "claude-opus-5-5" };
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
        return answer(MODEL_ANSWER);
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
      ["success", { report: { outcome: "succeeded", attempts: 1, attemptOutcomes: ["valid"], ...FAKE } }],
      ["success, with the provider's own model string", { env: () => ANTHROPIC, jobDeps: () => deps(scriptedProvider([answer(MODEL_ANSWER)])), report: { outcome: "succeeded", attempts: 1, attemptOutcomes: ["valid"], provider: "anthropic", model: "scripted-1" } }],
      ["success, with a model string over 200 UTF-16 units", { jobDeps: () => deps(scriptedProvider([{ ...answer(MODEL_ANSWER), model: "m".repeat(201) }])), report: { outcome: "succeeded", attempts: 1, attemptOutcomes: ["valid"], ...FAKE } }],
      ["template fallback: a first build after three timeouts (usage unknown)", { env: () => ({ FAKE_MODE: "timeout" }), report: { outcome: "fallback", attempts: 3, usedFallback: true, fallbackReason: "provider_error", providerErrorKind: "timeout", attemptOutcomes: TIMEOUTS, usageMissing: true, ...FAKE } }],
      ["a regeneration that failed after three timeouts (usage unknown)", { kind: "regenerate", env: () => ({ FAKE_MODE: "timeout" }), report: { outcome: "failed", attempts: 3, errorCode: "provider_timeout", providerErrorKind: "timeout", attemptOutcomes: TIMEOUTS, usageMissing: true, ...FAKE } }],
      ["a regeneration that failed after three invalid answers", { kind: "regenerate", env: () => ({ FAKE_MODE: "invalid-always" }), report: { outcome: "failed", attempts: 3, errorCode: "invalid_output", attemptOutcomes: ["invalid", "invalid", "invalid"], ...FAKE } }],
      ["claim refusal: switched off, a first build gets the template", { env: () => ({ GENERATION_ENABLED: "false" }), report: { outcome: "fallback", usedFallback: true, fallbackReason: "disabled" } }],
      ["claim refusal: today's model calls used up, a regeneration fails", { kind: "regenerate", setting: ["generation.daily_model_limit", "0"], report: { outcome: "failed", errorCode: "budget_exhausted" } }],
      ["provider failure: no key, a first build gets the template", { env: () => ANTHROPIC, report: { outcome: "fallback", usedFallback: true, fallbackReason: "provider_error", providerErrorKind: "auth", provider: "anthropic" } }],
      ["provider failure: no key, a regeneration fails", { kind: "regenerate", env: () => ANTHROPIC, report: { outcome: "failed", errorCode: "provider_unavailable", providerErrorKind: "auth", provider: "anthropic" } }],
      ["provider failure: the input guard refused attempt 1, a regeneration fails", { kind: "regenerate", input: JSON.stringify(OVER_BOUND), jobDeps: () => deps(scriptedProvider([])), report: { outcome: "failed", errorCode: "provider_unavailable", providerErrorKind: "bad_request", attemptOutcomes: ["bad_request"], inputBoundRefused: true, ...FAKE } }],
      ["catch-all: our own code threw after a call (costUnknown), a first build gets the template", { env: () => ANTHROPIC, jobDeps: () => deps(scriptedProvider([answerOurCodeCannotCheck()])), report: { outcome: "fallback", usedFallback: true, fallbackReason: "provider_error", costUnknown: true, ...REQUESTED } }],
      ["catch-all: our own code threw after a call (costUnknown), a regeneration fails", { kind: "regenerate", env: () => ANTHROPIC, jobDeps: () => deps(scriptedProvider([answerOurCodeCannotCheck()])), report: { outcome: "failed", errorCode: "internal", costUnknown: true, ...REQUESTED } }],
      ["catch-all: our own code threw before any call, a first build gets the template", { jobDeps: () => ({ ...deps(), createProvider: () => { throw new TypeError("bug"); } }), report: { outcome: "fallback", usedFallback: true, fallbackReason: "provider_error" } }],
      ["the stored input is not a valid snapshot", { input: '{"facts":{}}', report: { outcome: "failed", errorCode: "internal" } }],
      ["not claimed: no queued job", { notQueued: true, report: { outcome: "not_claimed" } }],
      ["read_failed: the claimed row cannot be read", { env: () => ({ DB: failingDb((sql) => sql.startsWith("SELECT kind")) }), report: { outcome: "read_failed" } }],
      ["lost: the row was finished by someone else first", { jobDeps: () => deps(finishesFirst()), report: { outcome: "lost", attempts: 1, attemptOutcomes: ["valid"], provider: "fake", model: "scripted-1" } }],
      ["write_failed: the final write failed", { env: () => ({ DB: failingDb((sql) => sql.includes("finished_at = ?")) }), report: { outcome: "write_failed", attempts: 1, attemptOutcomes: ["valid"], ...FAKE } }],
    ])("%s", async (_path, path) => {
      if (path.setting) await setSetting(db, ...path.setting);
      if (!path.notQueued) await queued("g1", path.kind, "s1", path.input);
      const report = await runGenerationJob(envWith(path.env?.()), "g1", path.jobDeps?.() ?? deps());
      expect(report).toEqual({ ...REPORT, ...path.report });
      if (report.outcome === "succeeded" || report.outcome === "fallback" || report.outcome === "failed") {
        const row = await getGeneration(db, "g1");
        expect({ provider: row.provider, model: row.model }).toEqual({ provider: report.provider, model: report.model });
      }
    });
  });

  // Task 9 follow-up item 2: the Worker hands each report to its log line, and a caller may edit it. Each path below
  // records no attempt, so its report's attemptOutcomes is empty: it must be a new array every time. `path` checks that
  // the job took that path (Task 10 follow-up item 9 added three more; follow-up 2 item 8 the last, which gets report()'s
  // own default, as read_failed does).
  it.each<[string, { env?: Partial<JobEnv>; jobDeps?: () => JobDeps; input?: string; notQueued?: true; path: Partial<JobReport> }]>([
    ["no model slot (switched off)", { env: { GENERATION_ENABLED: "false" }, path: { outcome: "fallback", fallbackReason: "disabled" } }],
    ["a provider it cannot build (no key)", { env: { MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-opus-5-5" }, path: { outcome: "fallback", providerErrorKind: "auth" } }],
    ["our own code threw before any call", { jobDeps: () => ({ ...deps(), createProvider: () => { throw new TypeError("bug"); } }), path: { outcome: "fallback", costUnknown: false } }],
    ["our own code threw after a call was sent (costUnknown)", { jobDeps: () => deps(scriptedProvider([answerOurCodeCannotCheck()])), path: { outcome: "fallback", costUnknown: true } }],
    ["the stored input is not a valid snapshot", { input: '{"facts":{}}', path: { outcome: "failed", errorCode: "internal" } }],
    ["the stored input is not JSON", { input: "not json", path: { outcome: "failed", errorCode: "internal" } }],
    ["no queued job (not_claimed)", { notQueued: true, path: { outcome: "not_claimed" } }],
  ])("gives each report its own attemptOutcomes, so editing one never changes a later job's report: %s", async (_path, { env, jobDeps, input, notQueued, path }) => {
    if (!notQueued) {
      await queued("a", "first", "s1", input);
      await queued("b", "first", "s2", input);
    }
    const first = await runGenerationJob(envWith(env), "a", jobDeps?.() ?? deps());
    expect(first).toMatchObject({ ...path, attemptOutcomes: [] });
    first.attemptOutcomes.push("valid");
    const second = await runGenerationJob(envWith(env), "b", jobDeps?.() ?? deps());
    expect(second).toMatchObject({ ...path, attemptOutcomes: [] });
  });

  // P3-4a: an attempt whose usage is unknown (the provider sent none, or a sent call timed out) flags the report.
  it.each([
    ["an answer came without usage", true, {}, () => scriptedProvider([{ ...answer({}), usageMissing: true }, answer(MODEL_ANSWER)])],
    ["every sent call timed out", true, { FAKE_MODE: "timeout" }, undefined],
    ["every answer came with usage", false, {}, () => scriptedProvider([answer({}), answer(MODEL_ANSWER)])],
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

  // P3-18: attempt 1's invalid answer grew attempt 2's prompt (its repair lines), so the model's answer failed, not the
  // provider: the fallback reason is invalid_output, and providerErrorKind is null, as for every invalid_output (Task 10
  // follow-up 2 item 2). The refusal stays recorded (the attempt's bad_request, inputBoundRefused).
  it("keeps the model slot when the input guard refuses attempt 2 after attempt 1 was sent, and gives a first build the template with fallback reason invalid_output", async () => {
    await queued("g1");
    const provider = scriptedProvider([answer(withUnknownKeys(MODEL_ANSWER, FDFA)), answer(MODEL_ANSWER)]);
    expect(await runGenerationJob(envWith(), "g1", deps(provider))).toMatchObject({
      outcome: "fallback",
      fallbackReason: "invalid_output",
      attempts: 1,
      providerErrorKind: null,
      attemptOutcomes: ["invalid", "bad_request"],
      inputBoundRefused: true,
    });
    expect(provider.requests).toHaveLength(1);
    expect(await getGeneration(db, "g1")).toMatchObject({ status: "succeeded", used_fallback: 1, fallback_reason: "invalid_output", attempts: 1, model_slot: 1, input_tokens: 100, output_tokens: 50 });
  });

  // task-9-additions C: generateDraft rejects only when our own code throws (a bug), and paid calls may have been sent by
  // then. Decision 24 still holds (a first build gets the template, a regeneration fails with internal), but the job
  // keeps the model slot, records attempts, tokens and cost as 0 (unknown) and flags costUnknown. It stores the
  // configured provider and the requested model, so the row says which model got the calls (Task 9 follow-up item 3).
  it("keeps the model slot and flags the cost as unknown when our own code throws after a call was sent", async () => {
    await queued("f");
    await queued("r", "regenerate", "s2");
    const first = scriptedProvider([answerOurCodeCannotCheck()]);
    const regeneration = scriptedProvider([answerOurCodeCannotCheck()]);
    const requested = { provider: "fake", model: "fake-template" };
    const unknown = { attempts: 0, costUnknown: true, usageMissing: false, providerErrorKind: null, attemptOutcomes: [], ...requested };
    expect(await runGenerationJob(envWith(), "f", deps(first))).toMatchObject({ outcome: "fallback", fallbackReason: "provider_error", ...unknown });
    expect(await runGenerationJob(envWith(), "r", deps(regeneration))).toMatchObject({ outcome: "failed", errorCode: "internal", ...unknown });
    expect([first.requests.length, regeneration.requests.length]).toEqual([1, 1]);
    const kept = { model_slot: 1, attempts: 0, input_tokens: 0, output_tokens: 0, cost_microusd: 0, ...requested };
    const firstRow = await getGeneration(db, "f");
    expect(firstRow).toMatchObject({ status: "succeeded", used_fallback: 1, fallback_reason: "provider_error", error_code: null, ...kept });
    expect(AiDraft.parse(JSON.parse(firstRow.output_json!))).toEqual(TEMPLATE);
    expect(await getGeneration(db, "r")).toMatchObject({ status: "failed", error_code: "internal", output_json: null, ...kept });
  });

  // Task 9 follow-up item 8 (task-9-additions B and C): the job gives the model slot back only when it knows that no call
  // was sent. A configuration value whose read throws proves that rule wherever the throw lands; it is not a production
  // path (the runtime's env holds plain values). The regeneration gets three invalid answers, so every attempt sends a call.
  // Task 10 follow-up 2 item 1: the job reads each key once, before any call (job.ts callModel). A read-1 row shows that
  // its read threw (no call, the slot goes back). A read-2 row shows that the read never comes: the key is read exactly
  // once and the three calls keep the slot, so a read after the calls fails it even where the slot would be kept anyway.
  it.each([
    ["MODEL_PROVIDER", 1, 0, "the read throws before any call"],
    ["MODEL_PROVIDER", 2, 3, "read once, before any call, so that read never comes"],
    ["MODEL_ID", 1, 0, "the read throws before any call"],
    ["MODEL_ID", 2, 3, "read once, before any call, so that read never comes"],
  ] as const)("gives the model slot back only when no call was sent, with reading %s set to throw on read %i (%i calls: %s)", async (key, failingRead, calls, _why) => {
    await queued("r", "regenerate");
    const provider = scriptedProvider([answer({}), answer({}), answer({})]);
    const env = envWith();
    const value = env[key];
    let reads = 0;
    Object.defineProperty(env, key, {
      get: () => {
        reads += 1;
        if (reads === failingRead) throw new TypeError(`reading ${key}`);
        return value;
      },
    });
    await runGenerationJob(env, "r", deps(provider));
    const sent = provider.requests.length;
    expect(sent, "calls sent").toBe(calls);
    expect((await getGeneration(db, "r")).model_slot, `${sent} calls sent`).toBe(sent > 0 ? 1 : 0);
    if (failingRead === 1) expect(reads, `reads of ${key}`).toBeGreaterThanOrEqual(failingRead);
    else expect(reads, `reads of ${key}`).toBe(1);
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
    const provider = scriptedProvider([{ ...answer(MODEL_ANSWER), model: model as unknown as string }]);
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
  type EndState = {
    snapshot?: GenerationInputSnapshot; env?: Partial<JobEnv>; setting?: [string, string]; provider?: () => ModelProvider;
    row: Partial<GenerationRow>; counted: boolean; report?: Partial<JobReport>;
  };

  it.each<[string, EndState]>([
    ["refused at claim time: generation is switched off", { env: { GENERATION_ENABLED: "false" }, row: { status: "failed", error_code: "generation_disabled", attempts: 0, model_slot: 0 }, counted: false }],
    ["refused at claim time: today's model calls are used up", { setting: ["generation.daily_model_limit", "0"], row: { status: "failed", error_code: "budget_exhausted", attempts: 0, model_slot: 0 }, counted: false }],
    ["refused at claim time: no key", { env: { MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-opus-5-5" }, row: { status: "failed", error_code: "provider_unavailable", attempts: 0, model_slot: 0 }, counted: false }],
    ["the input guard refused attempt 1", { snapshot: OVER_BOUND, provider: () => scriptedProvider([]), row: { status: "failed", error_code: "provider_unavailable", attempts: 0, model_slot: 0 }, counted: false }],
    ["our own code threw after a call was sent (costUnknown)", { provider: () => scriptedProvider([answerOurCodeCannotCheck()]), row: { status: "failed", error_code: "internal", attempts: 0, model_slot: 1, provider: "fake", model: "fake-template" }, counted: false }],
    ["three invalid answers", { env: { FAKE_MODE: "invalid-always" }, row: { status: "failed", error_code: "invalid_output", attempts: 3, model_slot: 1 }, counted: true }],
    // P3-18: the owner's notes fill attempt 1 to the input bound; its invalid answer's repair lines make the guard refuse
    // attempt 2. One billed call, and the model's answer failed: it counts, as three invalid answers do.
    // Its report: invalid_output with providerErrorKind null, as for every invalid_output (Task 10 follow-up 2 item 2).
    ["notes at the input bound, an invalid answer, then the input guard refused attempt 2 (P3-18)", { snapshot: AT_BOUND, provider: () => scriptedProvider([answer({}), answer(MODEL_ANSWER)]), row: { status: "failed", error_code: "invalid_output", attempts: 1, model_slot: 1 }, counted: true, report: { outcome: "failed", errorCode: "invalid_output", providerErrorKind: null, attemptOutcomes: ["invalid", "bad_request"], inputBoundRefused: true } }],
    // Task 10 follow-up 2 item 9: the same when a timeout came first. Attempt 2 resends the prompt at the bound and gets an
    // invalid answer, whose repair lines make the guard refuse attempt 3. Two billed calls, and the model's answer failed.
    ["notes at the input bound, a timeout, an invalid answer, then the input guard refused attempt 3 (P3-18)", { snapshot: AT_BOUND, provider: () => scriptedProvider([new ProviderError("timeout", "timed out"), answer({}), answer(MODEL_ANSWER)]), row: { status: "failed", error_code: "invalid_output", attempts: 2, model_slot: 1 }, counted: true, report: { outcome: "failed", errorCode: "invalid_output", providerErrorKind: null, attemptOutcomes: ["timeout", "invalid", "bad_request"], usageMissing: true, inputBoundRefused: true } }],
    // P3-18 changes only that refusal: a timeout or a 5xx after billed invalid answers is still the provider's fault.
    ["an invalid answer, then two timeouts", { provider: () => scriptedProvider([answer({}), new ProviderError("timeout", "timed out"), new ProviderError("timeout", "timed out")]), row: { status: "failed", error_code: "provider_timeout", attempts: 3, model_slot: 1 }, counted: false }],
    ["an invalid answer, then two 5xx answers", { provider: () => scriptedProvider([answer({}), new ProviderError("unavailable", "503"), new ProviderError("unavailable", "503")]), row: { status: "failed", error_code: "provider_unavailable", attempts: 3, model_slot: 1 }, counted: false }],
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
    const report = await runGenerationJob(envWith(end.env), request.generation.id, deps(end.provider?.()));
    expect(report).toMatchObject(end.report ?? {});
    expect(await getGeneration(db, request.generation.id)).toMatchObject({ kind: "regenerate", ...end.row });
    expect(await modelCallsToday(db, NOW)).toBe(end.row.model_slot);
    expect(await allowance()).toEqual({ generationsLeftToday: 4, generationsLeftTotal: end.counted ? 19 : 20 });
  });

  // P3-18 for a first build (web-maker-d3): the same attack ends with the template, stored with fallback reason
  // invalid_output (one classification in one place), and a first build never counts toward the owner's total.
  it("P3-18: a first build whose attempt 2 the input guard refused after an invalid answer gets the template with fallback reason invalid_output, and the owner's total is untouched", async () => {
    expect(await allowance()).toEqual({ generationsLeftToday: 5, generationsLeftTotal: 20 });
    const request = await requestGeneration({ DB: db, GEN_QUEUE, GENERATION_ENABLED: "true", DAILY_MODEL_LIMIT: "30" }, { siteId: "s1", ownerId: "o1", snapshot: AT_BOUND, now: NOW });
    if (!request.ok) throw new Error(`the request was refused: ${request.code}`);
    expect(request.generation.kind).toBe("first");
    const provider = scriptedProvider([answer({}), answer(MODEL_ANSWER)]);
    expect(await runGenerationJob(envWith(), request.generation.id, deps(provider))).toMatchObject({
      outcome: "fallback", usedFallback: true, fallbackReason: "invalid_output", errorCode: null, attempts: 1,
      providerErrorKind: null, attemptOutcomes: ["invalid", "bad_request"], inputBoundRefused: true,
    });
    // Attempt 1 was sent at exactly the bound; attempt 2 was never sent.
    expect(provider.requests.map((req) => inputBound(req))).toEqual([MAX_INPUT_TOKENS]);
    const row = await getGeneration(db, request.generation.id);
    expect(row).toMatchObject({ kind: "first", status: "succeeded", used_fallback: 1, fallback_reason: "invalid_output", error_code: null, attempts: 1, model_slot: 1 });
    expect(AiDraft.parse(JSON.parse(row.output_json!))).toEqual(templateDraft(AT_BOUND.facts, AT_BOUND.brief));
    expect(await modelCallsToday(db, NOW)).toBe(1);
    expect(await allowance()).toEqual({ generationsLeftToday: 4, generationsLeftTotal: 20 });
  });
});

// Part D (G1): D1 write retries, an unpriced model, the cost of an attempt with no usage, the job's time budget.
describe("runGenerationJob: G1 reliability and money", () => {
  const OPUS = { MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-opus-5-5", ANTHROPIC_API_KEY: "k" } as const;
  // Opus 5.5: 70,000 input tokens x $4 + 8,192 output tokens x $20 per million (models.ts).
  const ATTEMPT_WORST = 70_000 * 4 + 8_192 * 20;
  const FINISH_SQL = /SET status = \?2, output_json/;

  it("retries the terminal write once on a D1 transient error: the row ends and the report says so", async () => {
    await queued("g1");
    const flaky = failingRuns(db, FINISH_SQL, "D1_ERROR: Network connection lost");
    expect(await runGenerationJob(envWith({ DB: flaky.db }), "g1", deps())).toMatchObject({ outcome: "succeeded" });
    expect(flaky.runs()).toBe(2);
    expect(await getGeneration(db, "g1")).toMatchObject({ status: "succeeded", finished_at: NOW });
  });

  it("a retried write whose first try had committed (the reply was lost): the row is right and the report says lost (F6)", async () => {
    await queued("g1");
    const lost = failingRuns(db, FINISH_SQL, "D1_ERROR: Network connection lost", 1, true);
    expect(await runGenerationJob(envWith({ DB: lost.db }), "g1", deps())).toMatchObject({ outcome: "lost" });
    expect(lost.runs()).toBe(2);
    expect(await getGeneration(db, "g1")).toMatchObject({ status: "succeeded", finished_at: NOW, used_fallback: 0 });
  });

  it("does not retry an error that is not transient, and gives up after the one retry: the row stays running for the sweeper", async () => {
    await queued("g1");
    const broken = failingRuns(db, FINISH_SQL, "D1_ERROR: no such column: nope");
    expect(await runGenerationJob(envWith({ DB: broken.db }), "g1", deps())).toMatchObject({ outcome: "write_failed" });
    expect(broken.runs()).toBe(1);
    await queued("g2", "first", "s2");
    const down = failingRuns(db, FINISH_SQL, "D1_ERROR: Network connection lost", 5);
    expect(await runGenerationJob(envWith({ DB: down.db }), "g2", deps())).toMatchObject({ outcome: "write_failed" });
    expect(down.runs()).toBe(2);
    expect(await getGeneration(db, "g2")).toMatchObject({ status: "running" });
  });

  it("refuses an unpriced model before any provider is built: no call, the slot given back, a first build gets the template", async () => {
    await queued("g1");
    const build = vi.fn(() => scriptedProvider([answer(MODEL_ANSWER)]));
    const unpriced = { ...OPUS, MODEL_ID: "claude-fable-5-1" };
    expect(await runGenerationJob(envWith(unpriced), "g1", { ...deps(), createProvider: build })).toMatchObject({
      outcome: "fallback", attempts: 0, fallbackReason: "provider_error", providerErrorKind: "bad_request", provider: "anthropic",
    });
    expect(build).not.toHaveBeenCalled();
    expect(await getGeneration(db, "g1")).toMatchObject({ status: "succeeded", used_fallback: 1, model_slot: 0, attempts: 0, cost_microusd: 0 });
    expect(await modelCallsToday(db, NOW)).toBe(0);
  });

  it("refuses an unpriced model for a regeneration too: it fails as provider_unavailable and the owner's rewrite is not spent on a call", async () => {
    await insertGeneration(db, { id: "d1", site_id: "s1", owner_id: "o1", kind: "first", status: "succeeded", input_json: INPUT, created_at: NOW - 5000, output_json: JSON.stringify(TEMPLATE) });
    await queued("g1", "regenerate");
    const build = vi.fn(() => scriptedProvider([answer(MODEL_ANSWER)]));
    expect(await runGenerationJob(envWith({ ...OPUS, MODEL_ID: "claude-sonnet-5-5" }), "g1", { ...deps(), createProvider: build })).toMatchObject({ outcome: "failed", errorCode: "provider_unavailable", attempts: 0 });
    expect(build).not.toHaveBeenCalled();
    expect(await getGeneration(db, "g1")).toMatchObject({ status: "failed", model_slot: 0 });
  });

  it("records an attempt with no usage at its worst case, on top of the usage that was reported", async () => {
    await queued("g1");
    const provider = scriptedProvider([new ProviderError("timeout", "slow"), answer(MODEL_ANSWER, { inputTokens: 1000, outputTokens: 100 })]);
    expect(await runGenerationJob(envWith(OPUS), "g1", deps(provider))).toMatchObject({ outcome: "succeeded", attempts: 2, usageMissing: true });
    expect((await getGeneration(db, "g1")).cost_microusd).toBe(1000 * 4 + 100 * 20 + ATTEMPT_WORST);
  });

  it("records a returned answer whose usage was missing at its worst case too", async () => {
    await queued("g1");
    const provider = scriptedProvider([{ ...answer(MODEL_ANSWER, { inputTokens: 0, outputTokens: 0 }), usageMissing: true }]);
    await runGenerationJob(envWith(OPUS), "g1", deps(provider));
    expect((await getGeneration(db, "g1")).cost_microusd).toBe(ATTEMPT_WORST);
  });

  it("never records more than the job's worst case (three attempts), and an attempt with known usage is priced as before", async () => {
    await queued("g1");
    const timeouts = scriptedProvider([1, 2, 3].map(() => new ProviderError("timeout", "slow")));
    await runGenerationJob(envWith(OPUS), "g1", deps(timeouts));
    expect((await getGeneration(db, "g1")).cost_microusd).toBe(3 * ATTEMPT_WORST);
    await queued("g2", "first", "s2");
    await runGenerationJob(envWith(OPUS), "g2", deps(scriptedProvider([answer(MODEL_ANSWER, { inputTokens: 1000, outputTokens: 100 })])));
    expect((await getGeneration(db, "g2")).cost_microusd).toBe(1000 * 4 + 100 * 20);
  });

  it("never records less than the reported usage, even when it is above the job's worst case (M1)", async () => {
    await queued("g1");
    const huge = { inputTokens: 2_000_000, outputTokens: 0 };
    const provider = scriptedProvider([{ ...answer(MODEL_ANSWER, huge), usageMissing: true }]);
    await runGenerationJob(envWith(OPUS), "g1", deps(provider));
    expect((await getGeneration(db, "g1")).cost_microusd).toBe(2_000_000 * 4);
  });

  it("caps the sum at the job's worst case when the reported usage is already large and two attempts also flag it missing", async () => {
    await queued("g1");
    const big = { inputTokens: 70_000, outputTokens: 8_192 };
    const provider = scriptedProvider([{ ...answer({}, big), usageMissing: true }, { ...answer({}, big), usageMissing: true }, answer(MODEL_ANSWER, big)]);
    await runGenerationJob(envWith(OPUS), "g1", deps(provider));
    expect((await getGeneration(db, "g1")).cost_microusd).toBe(3 * ATTEMPT_WORST);
  });

  // A clock the provider's own slowness moves: each failed call took 120 s. The sweeper ends a running job after 6 minutes
  // (JOB_STUCK_AFTER_MS); with the 30 s margin the third attempt (starting at 248 s, 90 s to finish) cannot end in time.
  it("does not start an attempt that could not finish before the sweeper's threshold: the job ends as a timeout, nothing is sent for it", async () => {
    let clock = NOW;
    const sleeps: number[] = [];
    let calls = 0;
    const slow: ModelProvider = { id: "fake", generate: async () => { calls += 1; clock += 120_000; throw new ProviderError("unavailable", "down"); } };
    const timed: JobDeps = { ...deps(slow), generate: { sleep: async (ms) => void ((clock += ms), sleeps.push(ms)), timeoutSignal: () => new AbortController().signal, now: () => clock } };
    await queued("g1");
    expect(await runGenerationJob(envWith(), "g1", timed)).toMatchObject({
      outcome: "fallback", attempts: 2, providerErrorKind: "unavailable", fallbackReason: "provider_error", attemptOutcomes: ["unavailable", "unavailable"], usageMissing: false,
    });
    expect([calls, sleeps]).toEqual([2, [2_000]]);
    await insertGeneration(db, { id: "d1", site_id: "s2", owner_id: "o1", kind: "first", status: "succeeded", input_json: INPUT, created_at: NOW - 5000, output_json: JSON.stringify(TEMPLATE) });
    await queued("g2", "regenerate", "s2");
    clock = NOW;
    expect(await runGenerationJob(envWith(), "g2", timed)).toMatchObject({ outcome: "failed", errorCode: "provider_unavailable", attempts: 2 });
  });

  it("anchors the deadline at started_at: 250 s of slow work before the model call leave no room for an attempt (F1)", async () => {
    let clock = NOW;
    let calls = 0;
    const provider: ModelProvider = { id: "fake", generate: async () => { calls += 1; throw new ProviderError("unavailable", "down"); } };
    // The job's own clock says started_at is NOW; the generate clock has moved 250 s on by the time the call would be made.
    const late: JobDeps = { ...deps(provider), createProvider: () => { clock += 250_000; return provider; }, generate: { sleep: async () => {}, timeoutSignal: () => new AbortController().signal, now: () => clock } };
    await queued("g1");
    expect(await runGenerationJob(envWith(), "g1", late)).toMatchObject({ outcome: "fallback", attempts: 0, providerErrorKind: "timeout", fallbackReason: "provider_error", attemptOutcomes: [] });
    expect(calls).toBe(0);
    expect(await getGeneration(db, "g1")).toMatchObject({ status: "succeeded", used_fallback: 1, attempts: 0, model_slot: 0 });
  });
});

// Anthropic only in production, and the configuration the job cannot run on: a MODEL_PROVIDER that is missing in production
// refuses before any call, so the slot goes back (model_slot 0), a first build gets the template, and the row stores a null
// provider (an undefined one made the D1 write throw, so the row stayed running with its slot spent).
describe("a missing MODEL_PROVIDER in production", () => {
  it("gives a first build the template, with no call, the slot back and a null provider", async () => {
    await queued("g1");
    const { MODEL_PROVIDER: _missing, ...withoutProvider } = envWith({ ENVIRONMENT: "production", MODEL_ID: "claude-opus-5-5", ANTHROPIC_API_KEY: "k" });
    const report = await runGenerationJob(withoutProvider as unknown as JobEnv, "g1", deps());
    expect(report).toMatchObject({ outcome: "fallback", usedFallback: true, fallbackReason: "provider_error", attempts: 0, providerErrorKind: "bad_request", provider: null });
    const row = await getGeneration(db, "g1");
    expect(row).toMatchObject({ status: "succeeded", used_fallback: 1, fallback_reason: "provider_error", model_slot: 0, attempts: 0, provider: null, model: null });
    expect(row.finished_at).toBe(NOW);
    expect(AiDraft.parse(JSON.parse(row.output_json!))).toEqual(templateDraft(FULL_SNAPSHOT.facts, FULL_SNAPSHOT.brief));
    expect(await modelCallsToday(db, NOW)).toBe(0);
  });
});
