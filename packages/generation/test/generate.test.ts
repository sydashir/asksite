import { describe, expect, it } from "vitest";
import { ATTEMPT_TIMEOUT_MS, generateDraft, MAX_OUTPUT_TOKENS } from "../src/generate.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { AI_DRAFT_JSON_SCHEMA } from "../src/wire-schema.ts";
import { templateDraft } from "../src/template.ts";
import { FULL_SNAPSHOT } from "./support/samples.ts";
import { answer, ProviderError, scriptedProvider } from "./support/scripted.ts";

const good = templateDraft(FULL_SNAPSHOT.facts, FULL_SNAPSHOT.brief);
const bad = { ...good, copy: { ...good.copy, heroHeadline: "Call 555-0100 today" } };

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
  });

  it("adds up token usage over every attempt and records each attempt", async () => {
    const { deps } = testDeps();
    const provider = scriptedProvider([answer(bad, { inputTokens: 1000, outputTokens: 400 }), answer(good, { inputTokens: 1200, outputTokens: 300 })]);
    const result = await generateDraft(provider, FULL_SNAPSHOT, deps);
    expect(result.usage).toEqual({ inputTokens: 2200, outputTokens: 700 });
    expect(result.log).toEqual([
      { outcome: "invalid", issues: expect.any(Array), latencyMs: 10, usageMissing: false },
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
  });
});
