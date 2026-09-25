import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { ATTEMPT_TIMEOUT_MS, generateDraft, MAX_OUTPUT_TOKENS } from "../src/generate.ts";
import type { ModelProvider, ModelResponse } from "../src/provider.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { AI_DRAFT_JSON_SCHEMA } from "../src/wire-schema.ts";
import { templateDraft } from "../src/template.ts";
import { FULL_SNAPSHOT } from "./support/samples.ts";
import { answer, ProviderError, scriptedProvider } from "./support/scripted.ts";

const good = templateDraft(FULL_SNAPSHOT.facts, FULL_SNAPSHOT.brief);
const bad = { ...good, copy: { ...good.copy, heroHeadline: "Call 555-0100 today" } };

/** An answer that stopped for `stop` instead of ending normally. */
const stopped = (stop: ModelResponse["stop"], usage = { inputTokens: 100, outputTokens: 50 }): ModelResponse => ({ ...answer(undefined, usage), stop });

/** A provider whose `generate` calls return these promises in turn (then a valid answer), counting the calls. */
function providerOf(...calls: Array<() => Promise<ModelResponse>>): ModelProvider & { calls: number } {
  const provider = {
    id: "fake" as const,
    calls: 0,
    generate: () => (calls[provider.calls++] ?? (() => Promise.resolve(answer(good))))(),
  };
  return provider;
}

const never = (): Promise<ModelResponse> => new Promise(() => {});
const rejectAfter = (ms: number) => (): Promise<ModelResponse> => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), ms));

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
    expect(result).toMatchObject({ ok: true, draft: good, attempts: 1, validOnAttempt: 1, model: "fake-template" });
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
    expect(result).toMatchObject({ ok: false, failure: "invalid_output", attempts: 3, providerErrorKind: null });
    expect(!result.ok && result.issues.map((i) => i.path.join("."))).toContain("copy.heroHeadline");
  });

  it("waits 2 s and then 6 s between transient provider errors", async () => {
    const { deps, sleeps } = testDeps();
    const result = await generateDraft(new FakeProvider("timeout", FULL_SNAPSHOT), FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: false, failure: "provider_error", providerErrorKind: "timeout", attempts: 3 });
    expect(sleeps).toEqual([2_000, 6_000]);
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

  it("treats a cut-off or refused answer as invalid and asks for a shorter one", async () => {
    const { deps } = testDeps();
    const cut = { ...answer(undefined), stop: "max_tokens" as const };
    const provider = scriptedProvider([cut, { ...answer(undefined), stop: "refusal" as const }, answer(good)]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: true, attempts: 3 });
    expect(provider.requests[1]!.user).toContain("cut off");
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

  it("treats an answer that ended early as invalid and asks for the whole answer", async () => {
    const { deps } = testDeps();
    const provider = scriptedProvider([{ ...answer(undefined), stop: "other" as const }, answer(good)]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(provider.requests[1]!.user).toContain("ended early");
    expect(result.log.map((a) => a.outcome)).toEqual(["other", "valid"]);
    expect(result.log.map((a) => a.issues.map(({ path, code }) => ({ path, code })))).toEqual([[{ path: [], code: "incomplete" }], []]);
  });

  it("ends an attempt at its time limit itself when the provider ignores the signal, then carries on", async () => {
    const { deps, sleeps, timeouts } = testDeps();
    const provider = providerOf(never);
    const result = await generateDraft(provider, FULL_SNAPSHOT, { ...deps, timeoutSignal: (ms) => (timeouts.push(ms), AbortSignal.timeout(50)) });
    expect(result).toMatchObject({ ok: true, attempts: 2, validOnAttempt: 2 });
    expect(result.log.map((a) => a.outcome)).toEqual(["timeout", "valid"]);
    expect(sleeps).toEqual([2_000]);
    expect(timeouts).toEqual([ATTEMPT_TIMEOUT_MS, ATTEMPT_TIMEOUT_MS]);
  }, 5_000);

  it("treats an attempt whose signal has already aborted as a timeout at once", async () => {
    const { deps, sleeps } = testDeps();
    const provider = providerOf(never, never, never);
    const result = await generateDraft(provider, FULL_SNAPSHOT, { ...deps, timeoutSignal: () => AbortSignal.abort() });
    expect(result).toMatchObject({ ok: false, failure: "provider_error", providerErrorKind: "timeout", attempts: 3 });
    expect(result.log.map((a) => a.outcome)).toEqual(["timeout", "timeout", "timeout"]);
    expect(sleeps).toEqual([2_000, 6_000]);
    expect(provider.calls).toBe(3);
  }, 5_000);

  it("leaves no unhandled rejection when a provider rejects after its attempt timed out", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { deps } = testDeps();
      // Attempt 1's signal has already aborted; attempt 2's aborts after 20 ms. Both calls reject at 60 ms.
      const signals = [() => AbortSignal.abort(), () => AbortSignal.timeout(20), () => new AbortController().signal];
      const result = await generateDraft(providerOf(rejectAfter(60), rejectAfter(60)), FULL_SNAPSHOT, { ...deps, timeoutSignal: () => signals.shift()!() });
      expect(result.log.map((a) => a.outcome)).toEqual(["timeout", "timeout", "valid"]);
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
    expect(provider.requests[1]!.user.split("\n").at(-1)).toBe('- "": "The answer ended early. Send the whole answer."');
  });

  it("gives each result its own stop issues, so editing them cannot change a later job's repair prompt", async () => {
    const first = await generateDraft(scriptedProvider([stopped("max_tokens"), stopped("refusal"), stopped("other")]), FULL_SNAPSHOT, testDeps().deps);
    for (const issue of [...(first.ok ? [] : first.issues), ...first.log.flatMap((a) => a.issues)]) {
      issue.message = "INJECTED by an earlier caller";
      issue.path.push("injected");
    }
    for (const [stop, line] of [
      ["max_tokens", '- "": "The answer was cut off because it was too long. Keep every field well under its limit."'],
      ["refusal", '- "": "The answer was refused. Write ordinary marketing wording for this business."'],
      ["other", '- "": "The answer ended early. Send the whole answer."'],
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
    expect(provider.requests[1]!.user.split("\n").at(-1)).toBe('- "": "The answer was refused. Write ordinary marketing wording for this business."');
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
