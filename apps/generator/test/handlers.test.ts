import { runGenerationJob, sweepStuckJobs, type JobReport } from "@asksite/generation";
import type { MessageBatch } from "@cloudflare/workers-types";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";

// The Worker's handlers with the job and the sweeper replaced, so every log line can be pinned, including the ones the
// fake model never causes (usage_missing, generation.internal). worker.workerd.test.ts runs the real job end to end.
vi.mock("@asksite/generation", () => ({ runGenerationJob: vi.fn(), sweepStuckJobs: vi.fn() }));

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ENV = { MODEL_PROVIDER: "anthropic", MODEL_ID: "requested-model" } as unknown as Env;
const REPORT: JobReport = {
  outcome: "succeeded",
  generationId: ID,
  attempts: 1,
  usedFallback: false,
  errorCode: null,
  fallbackReason: null,
  providerErrorKind: null,
  attemptOutcomes: ["valid"],
  usageMissing: false,
  inputBoundRefused: false,
  costUnknown: false,
  durationMs: 12,
  provider: "anthropic",
  model: "stored-model",
};

function delivery(body: unknown) {
  const message = { id: "message-1", timestamp: new Date(0), body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
  const batch = { queue: "asksite-generation", messages: [message], ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<unknown>;
  return { message, batch };
}

let logged: MockInstance<typeof console.log>;
/** Every console.log call, each one JSON string parsed: the Worker logs exactly one argument per line. */
const lines = (): unknown[] =>
  logged.mock.calls.map((args) => {
    expect(args).toHaveLength(1);
    return JSON.parse(args[0] as string);
  });

beforeEach(() => {
  vi.mocked(runGenerationJob).mockReset();
  vi.mocked(sweepStuckJobs).mockReset();
  logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("queue: a finished job", () => {
  it("logs one generation.job line holding the whole report, then acknowledges the message", async () => {
    vi.mocked(runGenerationJob).mockResolvedValue(REPORT);
    const { message, batch } = delivery({ v: 1, generationId: ID });
    await worker.queue(batch, ENV);
    expect(vi.mocked(runGenerationJob).mock.calls).toEqual([[ENV, ID]]);
    expect(lines()).toEqual([{ event: "generation.job", ...REPORT }]);
    expect([message.ack.mock.calls.length, message.retry.mock.calls.length]).toEqual([1, 0]);
  });

  it("adds one usage_missing line with the provider and the model the job stored (P3-4a)", async () => {
    vi.mocked(runGenerationJob).mockResolvedValue({ ...REPORT, usageMissing: true });
    const { message, batch } = delivery({ v: 1, generationId: ID });
    await worker.queue(batch, ENV);
    expect(lines()).toEqual([
      { event: "generation.job", ...REPORT, usageMissing: true },
      { event: "usage_missing", generationId: ID, provider: "anthropic", model: "stored-model" },
    ]);
    expect([message.ack.mock.calls.length, message.retry.mock.calls.length]).toEqual([1, 0]);
  });

  it("adds one generation.internal line when our own code threw once a call could have been sent (Task 9 C)", async () => {
    const report: JobReport = { ...REPORT, outcome: "fallback", attempts: 0, usedFallback: true, fallbackReason: "provider_error", attemptOutcomes: [], costUnknown: true, model: "requested-model" };
    vi.mocked(runGenerationJob).mockResolvedValue(report);
    const { message, batch } = delivery({ v: 1, generationId: ID });
    await worker.queue(batch, ENV);
    expect(lines()).toEqual([
      { event: "generation.job", ...report },
      { event: "generation.internal", generationId: ID, costUnknown: true },
    ]);
    expect([message.ack.mock.calls.length, message.retry.mock.calls.length]).toEqual([1, 0]);
  });

  it("logs both extra lines, usage_missing first, when both flags are set", async () => {
    vi.mocked(runGenerationJob).mockResolvedValue({ ...REPORT, usageMissing: true, costUnknown: true });
    await worker.queue(delivery({ v: 1, generationId: ID }).batch, ENV);
    expect(lines().map((line) => (line as { event: string }).event)).toEqual(["generation.job", "usage_missing", "generation.internal"]);
  });

  it("adds no line for an input-bound refusal: the generation.job line carries it (P3-8)", async () => {
    vi.mocked(runGenerationJob).mockResolvedValue({ ...REPORT, inputBoundRefused: true });
    await worker.queue(delivery({ v: 1, generationId: ID }).batch, ENV);
    expect(lines()).toEqual([{ event: "generation.job", ...REPORT, inputBoundRefused: true }]);
  });
});

describe("queue: a message it cannot run", () => {
  it.each([
    ["another version", { v: 2, generationId: ID }],
    ["an id that is not a v4 UUID", { v: 1, generationId: "not-an-id" }],
    ["no id", { v: 1 }],
    ["an id that is not a string", { v: 1, generationId: 7 }],
    ["null", null],
    ["a string", ID],
  ])("acknowledges %s after logging its message id only, and runs no job", async (_name, body) => {
    const { message, batch } = delivery(body);
    await worker.queue(batch, ENV);
    expect(lines()).toEqual([{ event: "generation.bad_message", messageId: "message-1" }]);
    expect([message.ack.mock.calls.length, message.retry.mock.calls.length]).toEqual([1, 0]);
    expect(vi.mocked(runGenerationJob)).not.toHaveBeenCalled();
  });

  it("lets the queue retry when the job throws before its claim, logging the id only", async () => {
    vi.mocked(runGenerationJob).mockRejectedValue(new Error("D1 is down: Reliable Rooter"));
    const { message, batch } = delivery({ v: 1, generationId: ID });
    await worker.queue(batch, ENV);
    expect(lines()).toEqual([{ event: "generation.claim_failed", generationId: ID }]);
    expect([message.ack.mock.calls.length, message.retry.mock.calls.length]).toEqual([0, 1]);
  });
});

describe("queue: a provider error that needs a human, and the retry backoff", () => {
  it.each([
    ["auth", false, true],
    ["bad_request", false, true],
    ["bad_request", true, false],
    ["rate_limited", false, false],
    ["timeout", false, false],
    ["unavailable", false, false],
    [null, false, false],
  ] as const)("a job that ended with providerErrorKind %s (input guard %s): the extra line is %s", async (kind, inputBoundRefused, logsLine) => {
    vi.mocked(runGenerationJob).mockResolvedValue({ ...REPORT, outcome: "fallback", providerErrorKind: kind, inputBoundRefused });
    await worker.queue(delivery({ v: 1, generationId: ID }).batch, ENV);
    const events = lines().map((line) => (line as { event: string }).event);
    expect(events).toEqual(logsLine ? ["generation.job", "generation.needs_human"] : ["generation.job"]);
    if (logsLine) expect(lines()[1]).toEqual({ event: "generation.needs_human", generationId: ID, providerErrorKind: kind, provider: "anthropic" });
  });

  it.each([[1, 15], [2, 30], [3, 60], [9, 60], [0, 15]])("retries a failed claim on delivery %s after %s s", async (attempts, seconds) => {
    vi.mocked(runGenerationJob).mockRejectedValue(new Error("d1 down"));
    const { message, batch } = delivery({ v: 1, generationId: ID });
    (message as { attempts: number }).attempts = attempts;
    await worker.queue(batch, ENV);
    expect(message.retry.mock.calls).toEqual([[{ delaySeconds: seconds }]]);
  });
});

describe("scheduled", () => {
  // Counts only: the line never carries an error's text (Task 10 follow-up 2, item 4).
  it.each([
    ["a run that ended jobs", { fallback: 2, failed: 1, errors: 0 }],
    ["a run whose every write threw (a D1 outage), which must not look idle", { fallback: 0, failed: 0, errors: 3 }],
  ])("sweeps stuck jobs as of now and logs the counts, errors included: %s", async (_case, counts) => {
    vi.mocked(sweepStuckJobs).mockResolvedValue(counts);
    const before = Date.now();
    await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: 0, type: "scheduled", noRetry: () => undefined } as never, ENV);
    const [[env, now]] = vi.mocked(sweepStuckJobs).mock.calls as [[Env, number]];
    expect(env).toBe(ENV);
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
    expect(lines()).toEqual([{ event: "generation.sweep", ...counts }]);
  });

  it("logs one fixed generation.sweep_failed line, without the error's text, and rethrows so the runtime records the failure", async () => {
    const failure = new Error("d1 said secret-marker");
    vi.mocked(sweepStuckJobs).mockRejectedValue(failure);
    await expect(worker.scheduled({ cron: "*/5 * * * *", scheduledTime: 0, type: "scheduled", noRetry: () => undefined } as never, ENV)).rejects.toBe(failure);
    expect(logged.mock.calls).toEqual([['{"event":"generation.sweep_failed"}']]);
  });
});
