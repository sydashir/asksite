import { AiDraft } from "@asksite/core";
import { SiteDocument } from "@asksite/site-schema";
import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { capsSnapshot } from "../eval/caps.ts";
import { runGenerationJob, type JobDeps, type JobEnv } from "../src/job.ts";
import { createProvider } from "../src/providers/create.ts";
import type { ModelProvider } from "../src/provider.ts";
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
      durationMs: 0,
    });
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
});
