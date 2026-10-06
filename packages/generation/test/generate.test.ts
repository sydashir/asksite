import { getEventListeners } from "node:events";
import { Brief, type GenerationInputSnapshot, type Issue } from "@asksite/core";
import { Facts } from "@asksite/site-schema";
import { describe, expect, it, vi } from "vitest";
import { CAPS_REPAIR, CAPS_SNAPSHOT, capsRepair, capsSnapshot } from "../eval/caps.ts";
import { ATTEMPT_TIMEOUT_MS, capIssues, generateDraft, inputBound, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, PROMPT_OVERHEAD_TOKENS, type AttemptOutcome } from "../src/generate.ts";
import { buildPrompt, MAX_ISSUE_MESSAGE, MAX_ISSUE_PATH, MAX_REPAIR_ISSUES } from "../src/prompt.ts";
import type { ModelProvider, ModelRequest, ModelResponse } from "../src/provider.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { AI_DRAFT_JSON_SCHEMA, toWireSchema } from "../src/wire-schema.ts";
import { templateAnswer, templateDraft } from "../src/template.ts";
import { checkDraft } from "../src/validate.ts";
import { BRIEF, FULL_SNAPSHOT } from "./support/samples.ts";
import { answer, ProviderError, scriptedProvider } from "./support/scripted.ts";

const good = templateAnswer(FULL_SNAPSHOT.facts, FULL_SNAPSHOT.brief);
const bad = { ...good, copy: { ...good.copy, heroHeadline: "Call 555-0100 today" } };

/** An answer that stopped for `stop` instead of ending normally. */
const stopped = (stop: ModelResponse["stop"], usage = { inputTokens: 100, outputTokens: 50 }): ModelResponse => ({ ...answer(undefined, usage), stop });

/** A provider whose `generate` calls are these functions in turn (then a valid answer), counting the calls. */
function providerOf(...calls: Array<(req: ModelRequest) => Promise<ModelResponse>>): ModelProvider & { calls: number } {
  const provider = {
    id: "fake" as const,
    calls: 0,
    generate: (req: ModelRequest) => (calls[provider.calls++] ?? (() => Promise.resolve(answer(good))))(req),
  };
  return provider;
}

const never = (): Promise<ModelResponse> => new Promise(() => {});
const rejectAfter = (ms: number) => (): Promise<ModelResponse> => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), ms));

/**
 * A call that rejects with the signal's raw reason (not a ProviderError) from its own abort listener.
 * `listenersBefore` records how many abort listeners the signal had when this one was added: 0 means
 * it runs before generateDraft's, 1 after it.
 */
const rejectOnAbort = (listenersBefore: number[]) => (req: ModelRequest): Promise<ModelResponse> =>
  new Promise((_, reject) => {
    listenersBefore.push(getEventListeners(req.signal, "abort").length);
    req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true });
  });

/**
 * A call that answers from its own abort listener, which runs before generateDraft's (`listenersBefore`
 * records [0]): the answer wins the race, so our own code handles it after the signal has aborted.
 */
const answerOnAbort = (res: () => ModelResponse, listenersBefore: number[]) => (req: ModelRequest): Promise<ModelResponse> =>
  new Promise((resolve) => {
    listenersBefore.push(getEventListeners(req.signal, "abort").length);
    req.signal.addEventListener("abort", () => resolve(res()), { once: true });
  });

/** A value no JSON parser returns, but the provider contract (json: unknown) allows: any check of it throws a TypeError. */
const revokedProxy = (): object => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
};

function testDeps() {
  const sleeps: number[] = [];
  const timeouts: number[] = [];
  let clock = 0;
  return {
    sleeps,
    timeouts,
    deps: {
      sleep: async (ms: number) => void sleeps.push(ms),
      timeoutSignal: (ms: number) => (timeouts.push(ms), new AbortController().signal),
      now: () => (clock += 10),
    },
  };
}

describe("generateDraft", () => {
  it("returns the first valid answer", async () => {
    const { deps } = testDeps();
    const result = await generateDraft(new FakeProvider("ok", FULL_SNAPSHOT), FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: true, draft: templateDraft(FULL_SNAPSHOT.facts, FULL_SNAPSHOT.brief), attempts: 1, validOnAttempt: 1, model: "fake-template", inputBoundRefused: false });
  });

  it("sends the AI draft schema, the output cap and a 90 s signal on every attempt", async () => {
    const { deps, timeouts } = testDeps();
    const provider = scriptedProvider([answer(bad), answer(good)]);
    await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(provider.requests.map((r) => [r.jsonSchema, r.maxOutputTokens])).toEqual([
      [AI_DRAFT_JSON_SCHEMA, MAX_OUTPUT_TOKENS],
      [AI_DRAFT_JSON_SCHEMA, MAX_OUTPUT_TOKENS],
    ]);
    expect(timeouts).toEqual([ATTEMPT_TIMEOUT_MS, ATTEMPT_TIMEOUT_MS]);
  });

  it("sends the validation issues back as repair feedback, then accepts the fixed answer", async () => {
    const { deps, sleeps } = testDeps();
    const provider = scriptedProvider([answer(bad), answer(good)]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: true, attempts: 2, validOnAttempt: 2 });
    expect(provider.requests[0]!.user).not.toContain("previous answer");
    expect(provider.requests[1]!.user).toMatch(/previous answer was rejected[\s\S]*- "copy\.heroHeadline": /);
    expect(sleeps).toEqual([]);
  });

  it("gives up after three invalid answers and reports the last issues", async () => {
    const { deps } = testDeps();
    const result = await generateDraft(new FakeProvider("invalid-always", FULL_SNAPSHOT), FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: false, failure: "invalid_output", attempts: 3, providerErrorKind: null, inputBoundRefused: false });
    expect(!result.ok && result.issues.map((i) => i.path.join("."))).toContain("copy.heroHeadline");
  });

  it("waits 2 s and then 6 s between transient provider errors", async () => {
    const { deps, sleeps } = testDeps();
    const result = await generateDraft(new FakeProvider("timeout", FULL_SNAPSHOT), FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: false, failure: "provider_error", providerErrorKind: "timeout", attempts: 3 });
    expect(sleeps).toEqual([2_000, 6_000]);
    // Each call was sent and timed out: the provider may have billed it, so its usage is missing, never a silent 0.
    expect(result.log.map((a) => a.usageMissing)).toEqual([true, true, true]);
  });

  it("marks usage missing for a sent call that timed out, not for other provider errors without afterHeaders or noResponse", async () => {
    const { deps } = testDeps();
    const provider = scriptedProvider([new ProviderError("rate_limited", "429"), new ProviderError("unavailable", "503"), new ProviderError("timeout", "t")]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result.log.map((a) => [a.outcome, a.usageMissing])).toEqual([["rate_limited", false], ["unavailable", false], ["timeout", true]]);
  });

  it("marks usage missing for a sent call whose error came after a 2xx status line (afterHeaders, P3-11 d), whatever its kind", async () => {
    const { deps } = testDeps();
    const provider = scriptedProvider([new ProviderError("unavailable", "2xx body not JSON", { afterHeaders: true }), new ProviderError("bad_request", "2xx", { afterHeaders: true })]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: false, failure: "provider_error", providerErrorKind: "bad_request", attempts: 2 });
    expect(result.log.map((a) => [a.outcome, a.usageMissing])).toEqual([["unavailable", true], ["bad_request", true]]);
  });

  it("marks usage missing for a sent call whose error came with no status line (noResponse, P3-16 fix 5)", async () => {
    const { deps } = testDeps();
    const provider = scriptedProvider([new ProviderError("unavailable", "fetch failed", { noResponse: true }), answer(good)]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: true, attempts: 2, validOnAttempt: 2 });
    expect(result.log.map((a) => [a.outcome, a.usageMissing])).toEqual([["unavailable", true], ["valid", false]]);
  });

  it("keeps the last repair feedback across a transient error", async () => {
    const { deps, sleeps } = testDeps();
    const provider = scriptedProvider([answer(bad), new ProviderError("rate_limited", "429"), answer(good)]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: true, attempts: 3, validOnAttempt: 3 });
    expect(provider.requests[2]!.user).toContain('- "copy.heroHeadline": ');
    expect(sleeps).toEqual([2_000]);
  });

  it.each(["auth", "bad_request"] as const)("stops at once on a %s error", async (kind) => {
    const { deps, sleeps } = testDeps();
    const result = await generateDraft(scriptedProvider([new ProviderError(kind, "no")]), FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: false, failure: "provider_error", providerErrorKind: kind, attempts: 1 });
    expect(sleeps).toEqual([]);
  });

  it("treats an unexpected exception as a non-retryable provider error", async () => {
    const { deps } = testDeps();
    const result = await generateDraft(scriptedProvider([new TypeError("bug")]), FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: false, failure: "provider_error", providerErrorKind: "bad_request", attempts: 1 });
  });

  it("treats a cut-off or refused answer as invalid and tells the model it was cut off", async () => {
    const { deps } = testDeps();
    const cut = { ...answer(undefined), stop: "max_tokens" as const };
    const provider = scriptedProvider([cut, { ...answer(undefined), stop: "refusal" as const }, answer(good)]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: true, attempts: 3 });
    expect(provider.requests[1]!.user).toContain("was cut off");
    expect(result.log.map((a) => a.outcome)).toEqual(["max_tokens", "refusal", "valid"]);
    expect(result.log.map((a) => a.issues.map(({ path, code }) => ({ path, code })))).toEqual([[{ path: [], code: "cut_off" }], [{ path: [], code: "refused" }], []]);
  });

  it("adds up token usage over every attempt and records each attempt", async () => {
    const { deps } = testDeps();
    const provider = scriptedProvider([answer(bad, { inputTokens: 1000, outputTokens: 400 }), answer(good, { inputTokens: 1200, outputTokens: 300 })]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result.usage).toEqual({ inputTokens: 2200, outputTokens: 700 });
    expect(result.log).toEqual([
      { outcome: "invalid", issues: [expect.objectContaining({ path: ["copy", "heroHeadline"], code: "custom" })], latencyMs: 10, usageMissing: false },
      { outcome: "valid", issues: [], latencyMs: 10, usageMissing: false },
    ]);
  });

  it("marks an attempt whose provider sent no usage, for reporting only", async () => {
    const { deps, timeouts } = testDeps();
    const noUsage = { ...answer(bad, { inputTokens: 0, outputTokens: 0 }), usageMissing: true as const };
    const provider = scriptedProvider([noUsage, answer(good)]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(result.log.map((a) => a.usageMissing)).toEqual([true, false]);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(provider.requests.every((r) => r.maxOutputTokens === MAX_OUTPUT_TOKENS)).toBe(true);
    expect(timeouts).toEqual([ATTEMPT_TIMEOUT_MS, ATTEMPT_TIMEOUT_MS]);
  });

  it("a provider that never sends usage still gets at most MAX_ATTEMPTS attempts", async () => {
    const { deps } = testDeps();
    const noUsage = () => ({ ...answer(bad, { inputTokens: 0, outputTokens: 0 }), usageMissing: true as const });
    const provider = scriptedProvider([noUsage(), noUsage(), noUsage()]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: false, failure: "invalid_output", attempts: 3 });
    expect(result.log.map((a) => a.usageMissing)).toEqual([true, true, true]);
    expect(provider.requests).toHaveLength(3);
  });

  it("reports invalid output when a transient error is followed by invalid answers", async () => {
    const { deps, sleeps } = testDeps();
    const provider = scriptedProvider([new ProviderError("timeout", "t"), answer(bad), answer(bad)]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: false, failure: "invalid_output", providerErrorKind: null, attempts: 3 });
    expect(!result.ok && result.issues.map((i) => i.path.join("."))).toContain("copy.heroHeadline");
    expect(sleeps).toEqual([2_000]);
  });

  it("reports the provider error when invalid answers are followed by transient errors, keeping the model and the repair issues", async () => {
    const { deps, sleeps } = testDeps();
    const provider = scriptedProvider([answer(bad), new ProviderError("timeout", "t"), new ProviderError("timeout", "t")]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: false, failure: "provider_error", providerErrorKind: "timeout", attempts: 3, model: "scripted-1" });
    expect(!result.ok && result.issues.map((i) => i.path.join("."))).toContain("copy.heroHeadline");
    expect(sleeps).toEqual([2_000]);
  });

  it("treats an answer that ended early as invalid and tells the model the whole answer was not sent", async () => {
    const { deps } = testDeps();
    const provider = scriptedProvider([{ ...answer(undefined), stop: "other" as const }, answer(good)]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(provider.requests[1]!.user).toContain("ended before the whole answer was sent");
    expect(result.log.map((a) => a.outcome)).toEqual(["other", "valid"]);
    expect(result.log.map((a) => a.issues.map(({ path, code }) => ({ path, code })))).toEqual([[{ path: [], code: "incomplete" }], []]);
  });

  it("ends an attempt at its time limit itself when the provider ignores the signal, then carries on", async () => {
    const { deps, sleeps, timeouts } = testDeps();
    const provider = providerOf(never);
    const result = await generateDraft(provider, FULL_SNAPSHOT, { ...deps, timeoutSignal: (ms) => (timeouts.push(ms), AbortSignal.timeout(50)) });
    expect(result).toMatchObject({ ok: true, attempts: 2, validOnAttempt: 2 });
    expect(result.log.map((a) => a.outcome)).toEqual(["timeout", "valid"]);
    expect(result.log.map((a) => a.usageMissing)).toEqual([true, false]);
    expect(sleeps).toEqual([2_000]);
    expect(timeouts).toEqual([ATTEMPT_TIMEOUT_MS, ATTEMPT_TIMEOUT_MS]);
  }, 5_000);

  it("treats an attempt whose signal has already aborted as a timeout at once, without calling the provider (a late request is a paid call thrown away), so it is not counted in attempts", async () => {
    const { deps, sleeps } = testDeps();
    const provider = providerOf(never, never, never);
    const result = await generateDraft(provider, FULL_SNAPSHOT, { ...deps, timeoutSignal: () => AbortSignal.abort() });
    expect(result).toMatchObject({ ok: false, failure: "provider_error", providerErrorKind: "timeout", attempts: 0 });
    const timedOut = { outcome: "timeout", issues: [], latencyMs: 10, usageMissing: false };
    expect(result.log).toEqual([timedOut, timedOut, timedOut]);
    expect(sleeps).toEqual([2_000, 6_000]);
    expect(provider.calls).toBe(0);
  }, 5_000);

  it("carries on after an attempt whose signal had already aborted, as after any timeout: a pause, then the next attempt", async () => {
    const { deps, sleeps } = testDeps();
    const provider = providerOf();
    const signals = [() => AbortSignal.abort(), () => new AbortController().signal];
    const result = await generateDraft(provider, FULL_SNAPSHOT, { ...deps, timeoutSignal: () => signals.shift()!() });
    // attempts counts the calls sent (1); validOnAttempt is the loop's attempt number (2).
    expect(result).toMatchObject({ ok: true, attempts: 1, validOnAttempt: 2 });
    expect(result.log.map((a) => a.outcome)).toEqual(["timeout", "valid"]);
    expect(sleeps).toEqual([2_000]);
    expect(provider.calls).toBe(1);
  }, 5_000);

  it("classifies a raw abort error that a provider throws at once, after the signal aborted during the call, as a timeout", async () => {
    const { deps, sleeps } = testDeps();
    const deadline = new AbortController();
    const signals = [deadline.signal, new AbortController().signal];
    // The deadline passes during the call, and the provider throws the raw abort reason synchronously (no rejected promise).
    const provider = providerOf((req) => {
      deadline.abort();
      throw req.signal.reason;
    });
    const result = await generateDraft(provider, FULL_SNAPSHOT, { ...deps, timeoutSignal: () => signals.shift()! });
    expect(result.log.map((a) => a.outcome)).toEqual(["timeout", "valid"]);
    expect(result.log.map((a) => a.usageMissing)).toEqual([true, false]);
    expect(result).toMatchObject({ ok: true, attempts: 2, validOnAttempt: 2 });
    expect(sleeps).toEqual([2_000]);
    expect(provider.calls).toBe(2);
  });

  it.each<[string, boolean, number]>([
    ["the provider's abort listener runs first", false, 0],
    ["generateDraft's abort listener runs first", true, 1],
  ])("classifies a raw abort rejection, after the signal aborted during the call, as a timeout (%s)", async (_order, addsListenerLater, listenersAlready) => {
    const { deps, sleeps } = testDeps();
    const listenersBefore: number[] = [];
    const rejects = rejectOnAbort(listenersBefore);
    // After an await, the provider's listener comes after generateDraft's, which is added as soon as the call returns.
    const call = addsListenerLater
      ? async (req: ModelRequest) => {
          await Promise.resolve();
          return rejects(req);
        }
      : rejects;
    const signals = [() => AbortSignal.timeout(20), () => new AbortController().signal];
    const result = await generateDraft(providerOf(call), FULL_SNAPSHOT, { ...deps, timeoutSignal: () => signals.shift()!() });
    expect(listenersBefore).toEqual([listenersAlready]);
    expect(result.log.map((a) => a.outcome)).toEqual(["timeout", "valid"]);
    expect(result).toMatchObject({ ok: true, attempts: 2, validOnAttempt: 2 });
    expect(sleeps).toEqual([2_000]);
  }, 5_000);

  it("keeps a ProviderError's own kind when the signal has aborted too", async () => {
    const { deps, sleeps } = testDeps();
    const deadline = new AbortController();
    const provider = providerOf(() => {
      deadline.abort();
      return Promise.reject(new ProviderError("auth", "401"));
    });
    const result = await generateDraft(provider, FULL_SNAPSHOT, { ...deps, timeoutSignal: () => deadline.signal });
    expect(result).toMatchObject({ ok: false, failure: "provider_error", providerErrorKind: "auth", attempts: 1 });
    expect(sleeps).toEqual([]);
  });

  it.each<[string, () => Promise<ModelResponse>]>([
    ["rejects", () => Promise.reject(new TypeError("bug"))],
    [
      "throws at once",
      () => {
        throw new TypeError("bug");
      },
    ],
  ])("treats a provider call that %s with an unexpected exception, before any deadline, as a non-retryable bad request", async (_how, call) => {
    const { deps, sleeps } = testDeps();
    const provider = providerOf(call);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: false, failure: "provider_error", providerErrorKind: "bad_request", attempts: 1 });
    expect(result.log.map((a) => a.outcome)).toEqual(["bad_request"]);
    expect(sleeps).toEqual([]);
    expect(provider.calls).toBe(1);
  });

  // Answers that make our own code throw a TypeError. The revoked Proxy proves the classification rule, not a
  // production path: no JSON.parse output makes checkDraft throw, but the provider contract (json: unknown) allows it.
  const OUR_CODE_THROWS: Array<[string, () => ModelResponse, RegExp]> = [
    ["checkDraft's schema check", () => answer({ ...good, layout: [revokedProxy(), ...good.layout.slice(1)] }), /revoked/],
    ["checkDraft's service-name binding", () => answer({ ...good, copy: { ...good.copy, serviceDescriptions: [revokedProxy(), ...good.copy.serviceDescriptions.slice(1)] } }), /revoked/],
    ["the usage accounting", () => ({ ...answer(good), usage: undefined }) as unknown as ModelResponse, /inputTokens/],
  ];

  it.each(OUR_CODE_THROWS)("lets an exception from %s propagate: generateDraft rejects with it and records no provider error", async (_where, res, message) => {
    const { deps, sleeps } = testDeps();
    const provider = providerOf(() => Promise.resolve(res()));
    const run = generateDraft(provider, FULL_SNAPSHOT, deps);
    await expect(run).rejects.toBeInstanceOf(TypeError);
    await expect(run).rejects.toThrow(message);
    expect(sleeps).toEqual([]);
    expect(provider.calls).toBe(1);
  });

  it.each(OUR_CODE_THROWS)("lets an exception from %s propagate after the deadline passed too: never a timeout, never a bad request", async (_where, res, message) => {
    const { deps, sleeps } = testDeps();
    const listenersBefore: number[] = [];
    const provider = providerOf(answerOnAbort(res, listenersBefore));
    const signals = [() => AbortSignal.timeout(20), () => new AbortController().signal];
    const run = generateDraft(provider, FULL_SNAPSHOT, { ...deps, timeoutSignal: () => signals.shift()!() });
    await expect(run).rejects.toBeInstanceOf(TypeError);
    await expect(run).rejects.toThrow(message);
    expect(listenersBefore).toEqual([0]);
    expect(sleeps).toEqual([]);
    expect(provider.calls).toBe(1);
  }, 5_000);

  it("lets a timeoutSignal that throws propagate: generateDraft rejects with that error and calls no provider", async () => {
    const { deps, sleeps } = testDeps();
    const provider = providerOf();
    const noTimer = new RangeError("no timer");
    const run = generateDraft(provider, FULL_SNAPSHOT, {
      ...deps,
      timeoutSignal: () => {
        throw noTimer;
      },
    });
    await expect(run).rejects.toBe(noTimer);
    expect(sleeps).toEqual([]);
    expect(provider.calls).toBe(0);
  });

  it("ends an attempt as a timeout, without hanging, when the deadline passes while the provider call starts and the call never settles", async () => {
    const { deps, sleeps } = testDeps();
    const deadline = new AbortController();
    const signals = [deadline.signal, new AbortController().signal];
    // The abort event fires inside generate, before generateDraft could listen for it, and fires only once.
    const provider = providerOf(() => {
      deadline.abort();
      return never();
    });
    const result = await generateDraft(provider, FULL_SNAPSHOT, { ...deps, timeoutSignal: () => signals.shift()! });
    expect(result.log.map((a) => a.outcome)).toEqual(["timeout", "valid"]);
    expect(result).toMatchObject({ ok: true, attempts: 2, validOnAttempt: 2 });
    expect(sleeps).toEqual([2_000]);
  }, 1_000);

  it("keeps an answer that is already there when the deadline passed while the call started", async () => {
    const { deps, sleeps } = testDeps();
    const deadline = new AbortController();
    const provider = providerOf(() => {
      deadline.abort();
      return Promise.resolve(answer(good));
    });
    const result = await generateDraft(provider, FULL_SNAPSHOT, { ...deps, timeoutSignal: () => deadline.signal });
    expect(result.log.map((a) => a.outcome)).toEqual(["valid"]);
    expect(result).toMatchObject({ ok: true, attempts: 1, validOnAttempt: 1 });
    expect(sleeps).toEqual([]);
  });

  it("leaves no unhandled rejection when a provider rejects after its attempt timed out", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { deps } = testDeps();
      // Attempts 1 and 2 time out after 20 ms, during their calls; attempt 3's deadline passes as its call
      // starts. All three calls reject later, at 60 ms.
      const deadline = new AbortController();
      const signals = [() => AbortSignal.timeout(20), () => AbortSignal.timeout(20), () => deadline.signal];
      const abortsThenRejects = (): Promise<ModelResponse> => {
        deadline.abort();
        return rejectAfter(60)();
      };
      const result = await generateDraft(providerOf(rejectAfter(60), rejectAfter(60), abortsThenRejects), FULL_SNAPSHOT, { ...deps, timeoutSignal: () => signals.shift()!() });
      expect(result.log.map((a) => a.outcome)).toEqual(["timeout", "timeout", "timeout"]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 5_000);

  it("removes its abort listener when an attempt ends, so no signal keeps it", async () => {
    const { deps } = testDeps();
    const controllers: AbortController[] = [];
    const provider = scriptedProvider([answer(bad), new ProviderError("timeout", "t"), answer(good)]);
    const timeoutSignal = (): AbortSignal => controllers[controllers.push(new AbortController()) - 1]!.signal;
    await generateDraft(provider, FULL_SNAPSHOT, { ...deps, timeoutSignal });
    expect(controllers.map((c) => getEventListeners(c.signal, "abort").length)).toEqual([0, 0, 0]);
  });

  it.each(["pause_turn", "constructor"])("treats a stop reason outside the contract (%s) like an answer that ended early", async (stop) => {
    const { deps } = testDeps();
    const provider = scriptedProvider([stopped(stop as ModelResponse["stop"]), answer(good)]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(result.log.map((a) => a.outcome)).toEqual(["other", "valid"]);
    expect(provider.requests[1]!.user.split("\n").at(-1)).toBe('- "": "Your last answer ended before the whole answer was sent."');
  });

  it("gives each result its own stop issues, so editing them cannot change a later job's repair prompt", async () => {
    const first = await generateDraft(scriptedProvider([stopped("max_tokens"), stopped("refusal"), stopped("other")]), FULL_SNAPSHOT, testDeps().deps);
    for (const issue of [...(first.ok ? [] : first.issues), ...first.log.flatMap((a) => a.issues)]) {
      issue.message = "INJECTED by an earlier caller";
      issue.path.push("injected");
    }
    for (const [stop, line] of [
      ["max_tokens", '- "": "Your last answer was too long and was cut off before it ended."'],
      ["refusal", '- "": "Your last answer was a refusal, not wording for this business."'],
      ["other", '- "": "Your last answer ended before the whole answer was sent."'],
    ] as const) {
      const provider = scriptedProvider([stopped(stop), answer(good)]);
      await generateDraft(provider, FULL_SNAPSHOT, testDeps().deps);
      expect(provider.requests[1]!.user.split("\n").at(-1)).toBe(line);
    }
  });

  it("adds the token usage of cut-off, refused and ended-early answers to the total", async () => {
    const { deps } = testDeps();
    const provider = scriptedProvider([
      stopped("max_tokens", { inputTokens: 1000, outputTokens: 8192 }),
      stopped("refusal", { inputTokens: 700, outputTokens: 20 }),
      stopped("other", { inputTokens: 500, outputTokens: 10 }),
    ]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: false, failure: "invalid_output", attempts: 3 });
    expect(result.usage).toEqual({ inputTokens: 2200, outputTokens: 8222 });
  });

  it("reports invalid output when a transient error is followed by cut-off answers", async () => {
    const { deps, sleeps } = testDeps();
    const provider = scriptedProvider([new ProviderError("timeout", "t"), stopped("max_tokens"), stopped("max_tokens")]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: false, failure: "invalid_output", providerErrorKind: null, attempts: 3 });
    expect(sleeps).toEqual([2_000]);
  });

  it("answers a refusal with its own repair line", async () => {
    const { deps } = testDeps();
    const provider = scriptedProvider([stopped("refusal"), answer(good)]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result.log.map((a) => a.outcome)).toEqual(["refusal", "valid"]);
    expect(provider.requests[1]!.user.split("\n").at(-1)).toBe('- "": "Your last answer was a refusal, not wording for this business."');
  });

  it("keeps the earlier repair issues when an auth error stops the loop", async () => {
    const { deps, sleeps } = testDeps();
    const provider = scriptedProvider([answer(bad), new ProviderError("auth", "401")]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: false, failure: "provider_error", providerErrorKind: "auth", attempts: 2, model: "scripted-1" });
    expect(!result.ok && result.issues.map((i) => i.path.join("."))).toContain("copy.heroHeadline");
    expect(sleeps).toEqual([]);
  });
});

describe("the input bound (P3-8)", () => {
  const bytes = (text: string): number => new TextEncoder().encode(text).length;
  /** The bound of the first attempt's request for this snapshot (no repair lines). */
  const boundOf = (snapshot: GenerationInputSnapshot): number => inputBound({ ...buildPrompt(snapshot), jsonSchema: AI_DRAFT_JSON_SCHEMA });

  it.each<[string, string, number]>([
    ["ASCII: its raw bytes", "abc", 3],
    ["a decomposed accent, which NFC and NFKC shrink: its raw bytes", "e\u0301", 3],
    ["a fullwidth letter and U+1D160, which NFKC shrinks less than NFC grows: its NFC bytes", "\uFF21\u{1D160}", 15],
    ["U+FDFA: its NFKC bytes", "\uFDFA", 33],
  ])("counts the most UTF-8 bytes of the raw, NFC and NFKC text, plus the overhead, for %s", (_case, user, most) => {
    // toWireSchema({}) is {}: 2 bytes.
    expect(inputBound({ system: "", user, jsonSchema: {} })).toBe(most + 2 + PROMPT_OVERHEAD_TOKENS);
  });

  it("lets an exception from the bound's own measurement propagate: generateDraft rejects with it and calls no provider", async () => {
    // inputBound runs inside the attempt's try, so only the catch's rethrow keeps this bug from being recorded as a bad request.
    const { deps, sleeps } = testDeps();
    const provider = providerOf();
    const failure = new Error("measurement failed");
    const normalize = vi.spyOn(String.prototype, "normalize").mockImplementation(() => {
      throw failure;
    });
    try {
      await expect(generateDraft(provider, FULL_SNAPSHOT, deps)).rejects.toBe(failure);
    } finally {
      normalize.mockRestore();
    }
    expect(provider.calls).toBe(0);
    expect(sleeps).toEqual([]);
  });

  it("measures the system prompt, the user prompt and the schema as the adapters send it (toWireSchema), not the raw schema", () => {
    const schema = { type: "string", minLength: 1, $schema: "x" };
    expect(inputBound({ system: "ab", user: "c", jsonSchema: schema })).toBe(3 + bytes(JSON.stringify(toWireSchema(schema))) + PROMPT_OVERHEAD_TOKENS);
    expect(bytes(JSON.stringify(toWireSchema(schema)))).toBeLessThan(bytes(JSON.stringify(schema)));
  });

  it("lets through CAPS_SNAPSHOT with CAPS_REPAIR, the largest prompt by bytes: normalization does not grow it", () => {
    const { system, user } = buildPrompt(CAPS_SNAPSHOT, CAPS_REPAIR);
    const bound = inputBound({ system, user, jsonSchema: AI_DRAFT_JSON_SCHEMA });
    expect(bound).toBe(bytes(system) + bytes(user) + bytes(JSON.stringify(toWireSchema(AI_DRAFT_JSON_SCHEMA))) + PROMPT_OVERHEAD_TOKENS);
    expect(bound).toBeLessThanOrEqual(MAX_INPUT_TOKENS);
  });

  // Schema-valid owner text that NFC or NFKC makes longer: the byte proof alone would send it.
  it.each<[string, string]>([
    ["U+1D160", "\u{1D160}"],
    ["U+FB2C", "\uFB2C"],
    ["U+FDFA", "\uFDFA"],
    ["U+3316", "\u3316"],
  ])("refuses a schema-valid snapshot filled with %s before any call: attempts 0, inputBoundRefused, a bad request that is never retried", async (_name, fill) => {
    const snapshot = capsSnapshot(fill);
    expect(Facts.safeParse(snapshot.facts).success && Brief.safeParse(snapshot.brief).success).toBe(true);
    const { system, user } = buildPrompt(snapshot);
    expect(bytes(system) + bytes(user) + bytes(JSON.stringify(toWireSchema(AI_DRAFT_JSON_SCHEMA))) + PROMPT_OVERHEAD_TOKENS).toBeLessThanOrEqual(MAX_INPUT_TOKENS);
    expect(boundOf(snapshot)).toBeGreaterThan(MAX_INPUT_TOKENS);
    const { deps, sleeps } = testDeps();
    const provider = providerOf();
    const result = await generateDraft(provider, snapshot, deps);
    expect(provider.calls).toBe(0);
    expect(result).toEqual({
      ok: false,
      failure: "provider_error",
      providerErrorKind: "bad_request",
      issues: [],
      attempts: 0,
      model: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      log: [{ outcome: "bad_request", issues: [], latencyMs: 10, usageMissing: false }],
      inputBoundRefused: true,
    });
    expect(sleeps).toEqual([]);
  });

  /** An answer whose faq holds 20 entries, each with an unknown key made of `fill`: Zod's "Unrecognized key" message repeats the key, so the model's own text reaches the repair lines. */
  const withUnknownKeys = (base: typeof good, fill: string) => ({
    ...base,
    copy: { ...base.copy, faq: Array.from({ length: 20 }, (_, i) => ({ question: "Do you fix leaks?", answer: "Yes, we do.", [fill.repeat(300) + String(i)]: "x" })) },
  });

  it("sends CAPS_SNAPSHOT, and its next attempt after 20 real repair lines at their caps in the euro sign (the provider is called both times)", async () => {
    const valid = templateAnswer(CAPS_SNAPSHOT.facts, CAPS_SNAPSHOT.brief);
    const provider = scriptedProvider([answer(withUnknownKeys(valid, "\u20AC")), answer(valid)]);
    const result = await generateDraft(provider, CAPS_SNAPSHOT, testDeps().deps);
    expect(result).toMatchObject({ ok: true, attempts: 2, validOnAttempt: 2, inputBoundRefused: false });
    expect(provider.requests[1]!.user.split("\n").filter((line) => line.startsWith('- "copy.faq.')).length).toBe(20);
  });

  // A private-use character (U+E000) is unchanged by NFC and NFKC and costs 3 UTF-8 bytes, so the guard treats it like
  // the euro sign and sends it: a byte-level tokenizer never spends more tokens than bytes (Task 15 counts real tokens).
  it("sends a schema-valid snapshot filled with U+E000 (private use), which costs what the euro sign costs, and its next attempt after real repair lines", async () => {
    const snapshot = capsSnapshot("\uE000");
    expect(Facts.safeParse(snapshot.facts).success && Brief.safeParse(snapshot.brief).success).toBe(true);
    const { system, user } = buildPrompt(snapshot);
    expect(boundOf(snapshot)).toBe(bytes(system) + bytes(user) + bytes(JSON.stringify(toWireSchema(AI_DRAFT_JSON_SCHEMA))) + PROMPT_OVERHEAD_TOKENS);
    expect(boundOf(snapshot)).toBe(boundOf(capsSnapshot("\u20AC")));
    // With every repair line at its caps in U+E000 it stays within the proven maximum, CAPS_SNAPSHOT with CAPS_REPAIR.
    const largest = inputBound({ ...buildPrompt(CAPS_SNAPSHOT, CAPS_REPAIR), jsonSchema: AI_DRAFT_JSON_SCHEMA });
    expect(inputBound({ ...buildPrompt(snapshot, capsRepair("\uE000")), jsonSchema: AI_DRAFT_JSON_SCHEMA })).toBeLessThanOrEqual(largest);
    const valid = templateAnswer(snapshot.facts, snapshot.brief);
    const provider = scriptedProvider([answer(withUnknownKeys(valid, "\uE000")), answer(valid)]);
    const result = await generateDraft(provider, snapshot, testDeps().deps);
    expect(result).toMatchObject({ ok: true, attempts: 2, validOnAttempt: 2, inputBoundRefused: false });
    expect(provider.requests.map((req) => inputBound(req) <= largest)).toEqual([true, true]);
  });

  // Hangul U+D7A3 is 3 UTF-8 bytes and NFC and NFKC leave it unchanged, so the guard sends a snapshot filled with it,
  // repair lines included. NFD splits it into three 3-byte jamo (9 bytes), so a bound that also took NFD would refuse
  // this schema-valid owner text: adding NFD or NFKD waits for measured token counts (inputBound's comment, Task 15).
  // The run below sends attempt 2 with real repair lines, whose paths ("copy.faq.N") hold no Hangul, so its bound is
  // below the capsRepair one checked here; the attempt-2 boundary test further down proves that the guard sends a
  // repair attempt whose bound is exactly MAX_INPUT_TOKENS.
  it("keeps a schema-valid snapshot filled with Hangul U+D7A3 (owner text and service names) within the bound, with and without repair lines at their caps, and sends it and its next attempt after real repair lines", async () => {
    const hangul = "\uD7A3";
    const snapshot = capsSnapshot(hangul, hangul);
    expect(Facts.safeParse(snapshot.facts).success && Brief.safeParse(snapshot.brief).success).toBe(true);
    for (const repair of [[], capsRepair(hangul)]) {
      const { system, user } = buildPrompt(snapshot, repair);
      const text = system + user + JSON.stringify(toWireSchema(AI_DRAFT_JSON_SCHEMA));
      const bound = inputBound({ system, user, jsonSchema: AI_DRAFT_JSON_SCHEMA });
      // NFC and NFKC do not grow it: the bound is its raw bytes plus the overhead.
      expect(bound, `${repair.length} repair lines`).toBe(bytes(text) + PROMPT_OVERHEAD_TOKENS);
      expect(bound, `${repair.length} repair lines`).toBeLessThanOrEqual(MAX_INPUT_TOKENS);
      expect(bytes(text.normalize("NFD")) + PROMPT_OVERHEAD_TOKENS, `${repair.length} repair lines`).toBeGreaterThan(MAX_INPUT_TOKENS);
    }
    const valid = templateAnswer(snapshot.facts, snapshot.brief);
    const provider = scriptedProvider([answer(withUnknownKeys(valid, hangul)), answer(valid)]);
    const result = await generateDraft(provider, snapshot, testDeps().deps);
    expect(result).toMatchObject({ ok: true, attempts: 2, validOnAttempt: 2, inputBoundRefused: false });
    expect(provider.requests.map((req) => inputBound(req) <= MAX_INPUT_TOKENS)).toEqual([true, true]);
    expect(provider.requests[1]!.user.split("\n").filter((line) => line.startsWith('- "copy.faq.')).length).toBe(20);
  });

  it("refuses attempt 2 when the real repair lines of attempt 1 push it over: attempts 1, inputBoundRefused, no retry, and the model's answer failed (invalid_output, P3-18)", async () => {
    const { deps, sleeps } = testDeps();
    const provider = scriptedProvider([answer(withUnknownKeys(good, "\uFDFA")), answer(good)]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(provider.requests).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, failure: "invalid_output", providerErrorKind: null, attempts: 1, inputBoundRefused: true });
    expect(result.log.map((a) => [a.outcome, a.usageMissing])).toEqual([["invalid", false], ["bad_request", false]]);
    expect(sleeps).toEqual([]);
    const issues = result.ok ? [] : result.issues;
    // checkDraft found 21 issues (20 unknown keys and too many faq entries); the result keeps the first MAX_REPAIR_ISSUES.
    expect(issues).toHaveLength(MAX_REPAIR_ISSUES);
    expect(issues[0]).toMatchObject({ path: ["copy", "faq", 0], code: "unrecognized_keys" });
    // Attempt 1 was under the bound; attempt 2, with those repair lines, is over it.
    expect(inputBound(provider.requests[0]!)).toBeLessThanOrEqual(MAX_INPUT_TOKENS);
    expect(inputBound({ ...buildPrompt(FULL_SNAPSHOT, issues), jsonSchema: AI_DRAFT_JSON_SCHEMA })).toBeGreaterThan(MAX_INPUT_TOKENS);
  });

  it("sends a prompt whose bound is exactly MAX_INPUT_TOKENS and refuses one a byte over", async () => {
    const withNotes = (notes: string): GenerationInputSnapshot => ({ facts: FULL_SNAPSHOT.facts, brief: Brief.parse({ ...BRIEF, notes }) });
    // Each U+FDFA adds 33 NFKC bytes, each "n" exactly 1 to every measure; the notes stay under their 2,000 cap.
    const fdfa = "\uFDFA".repeat(Math.floor((MAX_INPUT_TOKENS - boundOf(withNotes("n")) - 40) / 33));
    const pad = MAX_INPUT_TOKENS - boundOf(withNotes(fdfa));
    const at = withNotes(fdfa + "n".repeat(pad));
    const over = withNotes(fdfa + "n".repeat(pad + 1));
    expect(pad).toBeGreaterThan(0);
    expect(fdfa.length + pad + 1).toBeLessThanOrEqual(2_000);
    expect([boundOf(at), boundOf(over)]).toEqual([MAX_INPUT_TOKENS, MAX_INPUT_TOKENS + 1]);
    const calls: number[] = [];
    for (const snapshot of [at, over]) {
      const provider = providerOf();
      await generateDraft(provider, snapshot, testDeps().deps);
      calls.push(provider.calls);
    }
    expect(calls).toEqual([1, 0]);
  });

  // The same edge on attempt 2: attempt 1 is sent and answered with 20 unknown keys, so attempt 2 carries real repair
  // lines. A guard with another limit for attempt 2, lower or higher, fails here; the next test does the same for attempt 3.
  it("sends attempt 2 with real repair lines when its bound is exactly MAX_INPUT_TOKENS, and refuses it a byte over", async () => {
    const withNotes = (notes: string): GenerationInputSnapshot => ({ facts: FULL_SNAPSHOT.facts, brief: Brief.parse({ ...BRIEF, notes }) });
    const wrong = withUnknownKeys(good, "\u20AC");
    // checkDraft reads only the facts and the answer, so every snapshot below gets these repair issues on attempt 2.
    const check = checkDraft(FULL_SNAPSHOT.facts, wrong);
    const issues = check.ok ? [] : check.issues;
    expect(issues.length).toBeGreaterThan(0);
    const secondBound = (snapshot: GenerationInputSnapshot): number => inputBound({ ...buildPrompt(snapshot, issues), jsonSchema: AI_DRAFT_JSON_SCHEMA });
    // As in the attempt-1 test: each U+FDFA adds 33 NFKC bytes, each "n" exactly 1 to every measure; the notes stay under their 2,000 cap.
    const fdfa = "\uFDFA".repeat(Math.floor((MAX_INPUT_TOKENS - secondBound(withNotes("n")) - 40) / 33));
    const pad = MAX_INPUT_TOKENS - secondBound(withNotes(fdfa));
    const at = withNotes(fdfa + "n".repeat(pad));
    const over = withNotes(fdfa + "n".repeat(pad + 1));
    expect(pad).toBeGreaterThan(0);
    expect(fdfa.length + pad + 1).toBeLessThanOrEqual(2_000);
    expect([secondBound(at), secondBound(over)]).toEqual([MAX_INPUT_TOKENS, MAX_INPUT_TOKENS + 1]);
    const runs: unknown[] = [];
    for (const snapshot of [at, over]) {
      const provider = scriptedProvider([answer(wrong), answer(good)]);
      const result = await generateDraft(provider, snapshot, testDeps().deps);
      const failure = result.ok ? null : result.failure;
      runs.push({ ok: result.ok, failure, attempts: result.attempts, inputBoundRefused: result.inputBoundRefused, sent: provider.requests.map((req) => inputBound(req)), outcomes: result.log.map((a) => a.outcome) });
    }
    expect(runs).toEqual([
      { ok: true, failure: null, attempts: 2, inputBoundRefused: false, sent: [boundOf(at), MAX_INPUT_TOKENS], outcomes: ["invalid", "valid"] },
      { ok: false, failure: "invalid_output", attempts: 1, inputBoundRefused: true, sent: [boundOf(over)], outcomes: ["invalid", "bad_request"] },
    ]);
  });

  // The same edge on attempt 3: attempt 1 is answered with a bad headline, and attempt 2, sent below the bound, with 20
  // unknown keys, so attempt 3 carries their real repair lines. A guard with another limit for attempt 3, lower or
  // higher, or with no check on attempt 3, fails here.
  it("sends attempt 3 with real repair lines when its bound is exactly MAX_INPUT_TOKENS, and refuses it a byte over", async () => {
    const withNotes = (notes: string): GenerationInputSnapshot => ({ facts: FULL_SNAPSHOT.facts, brief: Brief.parse({ ...BRIEF, notes }) });
    const wrong = withUnknownKeys(good, "\u20AC");
    // checkDraft reads only the facts and the answer, so every snapshot below gets these repair issues on attempts 2 and 3.
    const issuesOf = (json: unknown): Issue[] => {
      const check = checkDraft(FULL_SNAPSHOT.facts, json);
      return check.ok ? [] : check.issues;
    };
    const [secondIssues, thirdIssues] = [issuesOf(bad), issuesOf(wrong)];
    expect([secondIssues.length > 0, thirdIssues.length > 0]).toEqual([true, true]);
    const boundWith = (snapshot: GenerationInputSnapshot, issues: Issue[]): number => inputBound({ ...buildPrompt(snapshot, issues), jsonSchema: AI_DRAFT_JSON_SCHEMA });
    const thirdBound = (snapshot: GenerationInputSnapshot): number => boundWith(snapshot, thirdIssues);
    // As in the attempt-1 test: each U+FDFA adds 33 NFKC bytes, each "n" exactly 1 to every measure; the notes stay under their 2,000 cap.
    const fdfa = "\uFDFA".repeat(Math.floor((MAX_INPUT_TOKENS - thirdBound(withNotes("n")) - 40) / 33));
    const pad = MAX_INPUT_TOKENS - thirdBound(withNotes(fdfa));
    const at = withNotes(fdfa + "n".repeat(pad));
    const over = withNotes(fdfa + "n".repeat(pad + 1));
    expect(pad).toBeGreaterThan(0);
    expect(fdfa.length + pad + 1).toBeLessThanOrEqual(2_000);
    expect([thirdBound(at), thirdBound(over)]).toEqual([MAX_INPUT_TOKENS, MAX_INPUT_TOKENS + 1]);
    // Attempt 2 is below the bound in both runs, so only the guard on attempt 3 decides.
    expect(boundWith(over, secondIssues)).toBeLessThan(MAX_INPUT_TOKENS);
    const runs: unknown[] = [];
    for (const snapshot of [at, over]) {
      const provider = scriptedProvider([answer(bad), answer(wrong), answer(good)]);
      const result = await generateDraft(provider, snapshot, testDeps().deps);
      const failure = result.ok ? null : result.failure;
      runs.push({ ok: result.ok, failure, attempts: result.attempts, inputBoundRefused: result.inputBoundRefused, sent: provider.requests.map((req) => inputBound(req)), outcomes: result.log.map((a) => a.outcome) });
    }
    expect(runs).toEqual([
      { ok: true, failure: null, attempts: 3, inputBoundRefused: false, sent: [boundOf(at), boundWith(at, secondIssues), MAX_INPUT_TOKENS], outcomes: ["invalid", "invalid", "valid"] },
      { ok: false, failure: "invalid_output", attempts: 2, inputBoundRefused: true, sent: [boundOf(over), boundWith(over, secondIssues)], outcomes: ["invalid", "invalid", "bad_request"] },
    ]);
  });

  /** FULL_SNAPSHOT with notes sized so the first attempt's bound is exactly MAX_INPUT_TOKENS (as in the attempt-1 edge test). */
  const notesAtBound = (): GenerationInputSnapshot => {
    const withNotes = (notes: string): GenerationInputSnapshot => ({ facts: FULL_SNAPSHOT.facts, brief: Brief.parse({ ...BRIEF, notes }) });
    const fdfa = "\uFDFA".repeat(Math.floor((MAX_INPUT_TOKENS - boundOf(withNotes("n")) - 40) / 33));
    return withNotes(fdfa + "n".repeat(MAX_INPUT_TOKENS - boundOf(withNotes(fdfa))));
  };

  // P3-18 (the moderator's M1): an owner sizes the notes so attempt 1 just fits the bound. Any answer that is not valid
  // adds repair lines, so the guard refuses attempt 2. The model's answer failed, not the provider: the failure is
  // invalid_output (a regeneration then counts toward the owner's total, P3-16 (B)), so providerErrorKind is null, as for
  // every invalid_output (Task 10 follow-up 2 item 2). The refusal stays recorded: the log's bad_request, inputBoundRefused.
  it.each<[string, () => ModelResponse, AttemptOutcome]>([
    ["an invalid answer", () => answer(bad), "invalid"],
    ["a cut-off answer", () => stopped("max_tokens"), "max_tokens"],
    ["a refusal", () => stopped("refusal"), "refusal"],
  ])("fails with invalid_output, not a provider error, when %s makes the guard refuse attempt 2 of a prompt at the bound (P3-18)", async (_case, first, outcome) => {
    const snapshot = notesAtBound();
    expect(snapshot.brief.notes!.length).toBeLessThanOrEqual(2_000);
    const { deps, sleeps } = testDeps();
    const provider = scriptedProvider([first(), answer(good)]);
    const result = await generateDraft(provider, snapshot, deps);
    expect(provider.requests.map((req) => inputBound(req))).toEqual([MAX_INPUT_TOKENS]);
    expect(result).toMatchObject({ ok: false, failure: "invalid_output", providerErrorKind: null, attempts: 1, inputBoundRefused: true });
    expect(result.log.map((a) => a.outcome)).toEqual([outcome, "bad_request"]);
    expect(sleeps).toEqual([]);
  });

  // Task 10 follow-up 2 item 9: the rule needs an earlier sent answer that was not valid, not attempt 1's in particular.
  // Attempt 1 times out (sent, its usage unknown), attempt 2 sends the same prompt at the bound and is answered with a bad
  // headline, and that answer's repair lines make the guard refuse attempt 3: invalid_output, providerErrorKind null.
  it("fails with invalid_output when a timeout and then an invalid answer make the guard refuse attempt 3 of a prompt at the bound (P3-18)", async () => {
    const { deps, sleeps } = testDeps();
    const provider = scriptedProvider([new ProviderError("timeout", "timed out"), answer(bad), answer(good)]);
    const result = await generateDraft(provider, notesAtBound(), deps);
    expect(provider.requests.map((req) => inputBound(req))).toEqual([MAX_INPUT_TOKENS, MAX_INPUT_TOKENS]);
    expect(result).toMatchObject({ ok: false, failure: "invalid_output", providerErrorKind: null, attempts: 2, inputBoundRefused: true });
    expect(result.log.map((a) => [a.outcome, a.usageMissing])).toEqual([["timeout", true], ["invalid", false], ["bad_request", false]]);
    expect(sleeps).toEqual([2_000]);
  });

  // Only the guard's refusal of a prompt that an answer grew is the model's failure. A provider that refuses the request
  // itself (a 400) after an invalid answer is still a provider error, as is a refusal of attempt 1 (the test above that
  // fills the snapshot with U+FDFA) and a timeout or a 5xx after invalid answers (P3-16 (B): the provider's fault).
  it("keeps a provider's own bad request after an invalid answer a provider error (P3-18)", async () => {
    const provider = scriptedProvider([answer(bad), new ProviderError("bad_request", "400")]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, testDeps().deps);
    expect(result).toMatchObject({ ok: false, failure: "provider_error", providerErrorKind: "bad_request", attempts: 2, inputBoundRefused: false });
    expect(result.log.map((a) => a.outcome)).toEqual(["invalid", "bad_request"]);
  });
});

describe("capIssues (P3-8)", () => {
  const EMOJI = "\u{1F600}";
  /** Any UTF-16 surrogate: a capped text below holds no surrogate pair, so any match is a lone one. */
  const SURROGATE = /[\uD800-\uDFFF]/;

  it("keeps the first 20 of 30 long issues, each path cut to 60 and each message to 200 UTF-16 units, then well-formed", () => {
    // "copy." is 5 units, so the key keeps 55: its 55th unit is the first half of an emoji.
    // The message's 200th unit is the first half of an emoji too.
    const issues = Array.from({ length: 30 }, (_, i) => ({
      path: ["copy", `${"k".repeat(54)}${EMOJI}${"k".repeat(40)}`, i],
      code: "custom",
      message: `${String(i).padStart(2, "0")}${"m".repeat(197)}${EMOJI}${"m".repeat(50)}`,
    }));
    const capped = capIssues(issues);
    expect(capped.map((issue) => issue.message.slice(0, 2))).toEqual(Array.from({ length: 20 }, (_, i) => String(i).padStart(2, "0")));
    for (const issue of capped) {
      expect(issue.path).toEqual(["copy", `${"k".repeat(54)}\uFFFD`]);
      expect(issue.path.join(".")).toHaveLength(60);
      expect(issue.code).toBe("custom");
      expect(issue.message).toHaveLength(200);
      expect(issue.message.endsWith("\uFFFD")).toBe(true);
      expect(SURROGATE.test(issue.message) || SURROGATE.test(issue.path.join("."))).toBe(false);
    }
    expect(issues[0]!.path).toHaveLength(3);
    expect(issues[0]!.message).toHaveLength(251);
  });

  it.each<[string, Array<string | number>, Array<string | number>]>([
    ["keeps a short path whole", ["copy", "faq", 3, "answer"], ["copy", "faq", 3, "answer"]],
    ["keeps a path of exactly 60 units whole", ["a".repeat(57), 12], ["a".repeat(57), 12]],
    ["drops an index that crosses the cut", ["a".repeat(57), 123], ["a".repeat(57)]],
    ["cuts a first key to 60", ["b".repeat(70)], ["b".repeat(60)]],
    ["leaves out a key of which only the separator would fit", ["c".repeat(59), "d"], ["c".repeat(59)]],
    ["makes a lone surrogate in a kept key well-formed", ["copy", "x\uD800y"], ["copy", "x\uFFFDy"]],
  ])("cuts a path as the repair line writes it (keys joined with a dot) and keeps it a list: %s", (_case, path, want) => {
    expect(capIssues([{ path, code: "custom", message: "m" }])[0]!.path).toEqual(want);
  });

  // 'Unrecognized key: "' is 19 units and the key's first 180 are ASCII, so the message's 200-unit cut splits an emoji.
  const key = (i: number): string => `${"k".repeat(178)}${String(i).padStart(2, "0")}${EMOJI.repeat(20)}`;
  /** An answer with 31 issues: an unknown key in each of 30 faq entries (each message 240 units), and too many entries. */
  const hostile = { ...good, copy: { ...good.copy, faq: Array.from({ length: 30 }, (_, i) => ({ question: "Do you fix leaks?", answer: "Yes, we do.", [key(i)]: "x" })) } };

  it("records at most 20 issues per attempt and in the result, each cut like a repair line, for an answer with 31 issues", async () => {
    const raw = checkDraft(FULL_SNAPSHOT.facts, hostile);
    expect(raw.ok ? [] : raw.issues).toHaveLength(31);
    const result = await generateDraft(scriptedProvider([answer(hostile), answer(hostile), answer(hostile)]), FULL_SNAPSHOT, testDeps().deps);
    expect(result).toMatchObject({ ok: false, failure: "invalid_output", attempts: 3 });
    const recorded = [...result.log.map((a) => a.issues), result.ok ? [] : result.issues];
    expect(recorded).toHaveLength(4);
    for (const issues of recorded) {
      expect(issues.map((issue) => issue.path)).toEqual(Array.from({ length: 20 }, (_, i) => ["copy", "faq", i]));
      for (const issue of issues) {
        expect(issue.message).toHaveLength(200);
        expect(issue.message.endsWith("\uFFFD")).toBe(true);
        expect(SURROGATE.test(issue.message)).toBe(false);
      }
    }
  });

  it("caps the issues of a loop that stops early: an answer with 31 issues, then an auth error, returns 20, each cut like a repair line", async () => {
    const { deps, sleeps } = testDeps();
    const raw = checkDraft(FULL_SNAPSHOT.facts, hostile);
    expect(raw.ok ? [] : raw.issues).toHaveLength(31);
    const result = await generateDraft(scriptedProvider([answer(hostile), new ProviderError("auth", "401")]), FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: false, failure: "provider_error", providerErrorKind: "auth", attempts: 2 });
    expect(sleeps).toEqual([]);
    const issues = result.ok ? [] : result.issues;
    expect(issues).toHaveLength(MAX_REPAIR_ISSUES);
    for (const issue of issues) {
      expect(issue.message.length).toBeLessThanOrEqual(MAX_ISSUE_MESSAGE);
      expect(issue.path.join(".").length).toBeLessThanOrEqual(MAX_ISSUE_PATH);
    }
  });
});

describe("FakeProvider", () => {
  const request = (): ModelRequest => ({ system: "s", user: "u", jsonSchema: AI_DRAFT_JSON_SCHEMA, maxOutputTokens: MAX_OUTPUT_TOKENS, signal: new AbortController().signal });

  it("answers as a model does (A12): templateAnswer, palette and font with no design, and its invalid answer the same with a phone number in the headline", async () => {
    const valid = templateAnswer(FULL_SNAPSHOT.facts, FULL_SNAPSHOT.brief);
    expect((await new FakeProvider("ok", FULL_SNAPSHOT).generate(request())).json).toEqual(valid);
    expect((await new FakeProvider("invalid-once", FULL_SNAPSHOT).generate(request())).json).toEqual({ ...valid, copy: { ...valid.copy, heroHeadline: "Call 555-0100 today" } });
  });
});

// Items 6 and 7 (G1): the provider's Retry-After, and the job's time budget.
describe("generateDraft: Retry-After and the time budget", () => {
  const limited = (retryAfterSeconds?: number) => new ProviderError("rate_limited", "429", retryAfterSeconds === undefined ? {} : { retryAfterSeconds });

  it.each([
    ["a Retry-After of 10 s replaces the 2 s pause", [limited(10)], [10_000]],
    ["a longer Retry-After is capped at 30 s", [limited(120)], [30_000]],
    ["a Retry-After of 0 is honoured", [limited(0)], [0]],
    ["no Retry-After keeps the fixed 2 s and 6 s", [limited(), limited()], [2_000, 6_000]],
    ["each pause follows its own error", [limited(5), limited()], [5_000, 6_000]],
  ])("%s", async (_case, errors, expected) => {
    const { deps, sleeps } = testDeps();
    await generateDraft(scriptedProvider([...errors, answer(good)]), FULL_SNAPSHOT, deps);
    expect(sleeps).toEqual(expected);
  });

  it("with no budget given behaves as before (the eval's calls)", async () => {
    const { deps } = testDeps();
    const result = await generateDraft(scriptedProvider([limited(), answer(good)]), FULL_SNAPSHOT, deps, undefined);
    expect(result).toMatchObject({ ok: true, attempts: 2 });
  });

  /** A clock the test moves: every call the provider answers takes `took` ms. */
  function slowProvider(took: number, clockRef: { t: number }) {
    return providerOf(...[0, 1, 2].map(() => async (): Promise<ModelResponse> => { clockRef.t += took; throw new ProviderError("unavailable", "down"); }));
  }
  const timedDeps = (clock: { t: number }) => ({ sleep: async (ms: number) => void (clock.t += ms), timeoutSignal: () => new AbortController().signal, now: () => clock.t });

  it("does not wait for or start an attempt that could not finish inside the budget; nothing is sent for it", async () => {
    const clock = { t: 0 };
    const provider = slowProvider(120_000, clock);
    const result = await generateDraft(provider, FULL_SNAPSHOT, timedDeps(clock), 330_000);
    expect(provider.calls).toBe(2);
    expect(result).toMatchObject({ ok: false, failure: "provider_error", providerErrorKind: "timeout", attempts: 2 });
    expect(result.log.map((a) => a.outcome)).toEqual(["unavailable", "unavailable", "timeout"]);
    expect(result.log[2]).toMatchObject({ usageMissing: false });
    expect(clock.t).toBe(242_000); // 2 x 120 s and the 2 s pause; the 6 s pause before the third attempt was never waited
  });

  it("starts an attempt that fits exactly: the budget's edge is inclusive", async () => {
    const clock = { t: 0 };
    const provider = slowProvider(120_000, clock);
    // attempt 3 would start at 248 s and end by 338 s
    await generateDraft(provider, FULL_SNAPSHOT, timedDeps(clock), 248_000 + ATTEMPT_TIMEOUT_MS);
    expect(provider.calls).toBe(3);
  });

  it("a budget that is already spent sends no call at all", async () => {
    const clock = { t: 0 };
    const provider = slowProvider(1, clock);
    const result = await generateDraft(provider, FULL_SNAPSHOT, timedDeps(clock), ATTEMPT_TIMEOUT_MS - 1);
    expect([provider.calls, result.attempts, result.ok]).toEqual([0, 0, false]);
  });

  it("a Retry-After that does not fit the budget ends the job as well", async () => {
    const clock = { t: 0 };
    const provider = providerOf(async () => { clock.t += 1000; throw limited(30); });
    const result = await generateDraft(provider, FULL_SNAPSHOT, timedDeps(clock), 100_000);
    expect(provider.calls).toBe(1);
    expect(result).toMatchObject({ ok: false, providerErrorKind: "timeout" });
  });
});
