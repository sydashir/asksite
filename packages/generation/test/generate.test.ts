import { getEventListeners } from "node:events";
import { Brief, type GenerationInputSnapshot } from "@asksite/core";
import { Facts } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { CAPS_REPAIR, CAPS_SNAPSHOT, capsSnapshot } from "../eval/caps.ts";
import { ATTEMPT_TIMEOUT_MS, capIssues, generateDraft, inputBound, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, PROMPT_OVERHEAD_TOKENS } from "../src/generate.ts";
import { buildPrompt } from "../src/prompt.ts";
import type { ModelProvider, ModelRequest, ModelResponse } from "../src/provider.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { AI_DRAFT_JSON_SCHEMA, toWireSchema } from "../src/wire-schema.ts";
import { templateDraft } from "../src/template.ts";
import { checkDraft } from "../src/validate.ts";
import { BRIEF, FULL_SNAPSHOT } from "./support/samples.ts";
import { answer, ProviderError, scriptedProvider } from "./support/scripted.ts";

const good = templateDraft(FULL_SNAPSHOT.facts, FULL_SNAPSHOT.brief);
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
    expect(result).toMatchObject({ ok: true, draft: good, attempts: 1, validOnAttempt: 1, model: "fake-template", inputBoundRefused: false });
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

  it("marks usage missing only for a sent call that timed out, not for other provider errors", async () => {
    const { deps } = testDeps();
    const provider = scriptedProvider([new ProviderError("rate_limited", "429"), new ProviderError("unavailable", "503"), new ProviderError("timeout", "t")]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result.log.map((a) => [a.outcome, a.usageMissing])).toEqual([["rate_limited", false], ["unavailable", false], ["timeout", true]]);
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
  const withUnknownKeys = (draft: typeof good, fill: string) => ({
    ...draft,
    copy: { ...draft.copy, faq: Array.from({ length: 20 }, (_, i) => ({ question: "Do you fix leaks?", answer: "Yes, we do.", [fill.repeat(300) + String(i)]: "x" })) },
  });

  it("sends CAPS_SNAPSHOT, and its next attempt after 20 real repair lines at their caps in the euro sign (the provider is called both times)", async () => {
    const draft = templateDraft(CAPS_SNAPSHOT.facts, CAPS_SNAPSHOT.brief);
    const provider = scriptedProvider([answer(withUnknownKeys(draft, "\u20AC")), answer(draft)]);
    const result = await generateDraft(provider, CAPS_SNAPSHOT, testDeps().deps);
    expect(result).toMatchObject({ ok: true, attempts: 2, validOnAttempt: 2, inputBoundRefused: false });
    expect(provider.requests[1]!.user.split("\n").filter((line) => line.startsWith('- "copy.faq.')).length).toBe(20);
  });

  it("refuses attempt 2 when the real repair lines of attempt 1 push it over: attempts 1, inputBoundRefused, no retry", async () => {
    const { deps, sleeps } = testDeps();
    const provider = scriptedProvider([answer(withUnknownKeys(good, "\uFDFA")), answer(good)]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(provider.requests).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, failure: "provider_error", providerErrorKind: "bad_request", attempts: 1, inputBoundRefused: true });
    expect(result.log.map((a) => [a.outcome, a.usageMissing])).toEqual([["invalid", false], ["bad_request", false]]);
    expect(sleeps).toEqual([]);
    const issues = result.ok ? [] : result.issues;
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

  it("records at most 20 issues per attempt and in the result, each cut like a repair line, for an answer with 31 issues", async () => {
    // 'Unrecognized key: "' is 19 units and the key's first 180 are ASCII, so the message's 200-unit cut splits an emoji.
    const key = (i: number): string => `${"k".repeat(178)}${String(i).padStart(2, "0")}${EMOJI.repeat(20)}`;
    const hostile = { ...good, copy: { ...good.copy, faq: Array.from({ length: 30 }, (_, i) => ({ question: "Do you fix leaks?", answer: "Yes, we do.", [key(i)]: "x" })) } };
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
});
