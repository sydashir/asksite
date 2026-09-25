import type { AiDraft, GenerationInputSnapshot, Issue } from "@asksite/core";
import { buildPrompt } from "./prompt.ts";
import { ProviderError, TRANSIENT_KINDS, type ModelProvider, type ModelRequest, type ModelResponse, type ProviderErrorKind } from "./provider.ts";
import { checkDraft } from "./validate.ts";
import { AI_DRAFT_JSON_SCHEMA } from "./wire-schema.ts";

/** Design §6.3 constants. */
export const MAX_ATTEMPTS = 3;
export const ATTEMPT_TIMEOUT_MS = 90_000;
/** Pause before the attempt that follows the 1st and the 2nd transient provider error. */
export const RETRY_DELAYS_MS = [2_000, 6_000] as const;
/**
 * Output cap per attempt, reasoning tokens included. The largest valid AiDraft is about 7,000
 * characters of copy; the rest is room for reasoning. A cut-off answer counts as invalid.
 */
export const MAX_OUTPUT_TOKENS = 8_192;

export interface GenerateDeps {
  sleep(ms: number): Promise<void>;
  timeoutSignal(ms: number): AbortSignal;
  now(): number;
}

export const REAL_DEPS: GenerateDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutSignal: (ms) => AbortSignal.timeout(ms),
  now: () => Date.now(),
};

export type AttemptOutcome = "valid" | "invalid" | "max_tokens" | "refusal" | "other" | ProviderErrorKind;
export interface AttemptRecord {
  outcome: AttemptOutcome;
  issues: Issue[];
  latencyMs: number;
  usageMissing: boolean;
}

interface Common {
  attempts: number;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number };
  log: AttemptRecord[];
}
export type GenerateResult =
  | (Common & { ok: true; draft: AiDraft; validOnAttempt: number })
  | (Common & { ok: false; failure: "provider_error" | "invalid_output"; providerErrorKind: ProviderErrorKind | null; issues: Issue[] });

type StopReason = Exclude<ModelResponse["stop"], "end">;

const STOP_ISSUE: Record<StopReason, Omit<Issue, "path">> = {
  max_tokens: { code: "cut_off", message: "The answer was cut off because it was too long. Keep every field well under its limit." },
  refusal: { code: "refused", message: "The answer was refused. Write ordinary marketing wording for this business." },
  other: { code: "incomplete", message: "The answer ended early. Send the whole answer." },
};

/** A new issue on every call: a caller may edit the issues it gets back, and a later job must not see that. */
const stopIssue = (stop: StopReason): Issue => ({ path: [], ...STOP_ISSUE[stop] });

const attemptTimedOut = (): ProviderError => new ProviderError("timeout", "The attempt ran out of time");

/**
 * The provider's answer, or a timeout once the request's signal aborts, whichever comes first, so
 * the attempt limit holds even for a provider that ignores the signal. The call that loses may
 * still reject later; that is never an unhandled rejection. The abort listener is removed as soon
 * as the attempt ends.
 */
async function answerWithinLimit(provider: ModelProvider, req: ModelRequest): Promise<ModelResponse> {
  const call = provider.generate(req);
  call.catch(() => {});
  const { signal } = req;
  if (signal.aborted) throw attemptTimedOut();
  let onAbort = (): void => {};
  const timedOut = new Promise<never>((_, reject) => {
    onAbort = () => reject(attemptTimedOut());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([call, timedOut]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Up to MAX_ATTEMPTS model calls (design §6.3). Each answer is validated with checkDraft; a failed
 * check sends its issues back as repair feedback. An attempt that outlasts ATTEMPT_TIMEOUT_MS is a
 * timeout. Transient provider errors pause 2 s then 6 s; auth and bad-request errors stop at once.
 * Shared by the queue job and the eval.
 */
export async function generateDraft(provider: ModelProvider, snapshot: GenerationInputSnapshot, deps: GenerateDeps = REAL_DEPS): Promise<GenerateResult> {
  const usage = { inputTokens: 0, outputTokens: 0 };
  const log: AttemptRecord[] = [];
  let model: string | null = null;
  let repair: Issue[] = [];
  let failure: "provider_error" | "invalid_output" = "invalid_output";
  let providerErrorKind: ProviderErrorKind | null = null;
  let transientErrors = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { system, user } = buildPrompt(snapshot, repair);
    const started = deps.now();
    try {
      const res = await answerWithinLimit(provider, { system, user, jsonSchema: AI_DRAFT_JSON_SCHEMA, maxOutputTokens: MAX_OUTPUT_TOKENS, signal: deps.timeoutSignal(ATTEMPT_TIMEOUT_MS) });
      const latencyMs = deps.now() - started;
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      model = res.model;
      failure = "invalid_output";
      providerErrorKind = null;
      const usageMissing = res.usageMissing === true;
      if (res.stop !== "end") {
        // Adapters map an unknown stop reason to "other"; a value outside the contract is treated the same.
        const stop = Object.hasOwn(STOP_ISSUE, res.stop) ? res.stop : "other";
        repair = [stopIssue(stop)];
        log.push({ outcome: stop, issues: repair, latencyMs, usageMissing });
        continue;
      }
      const check = checkDraft(snapshot.facts, res.json);
      if (check.ok) {
        log.push({ outcome: "valid", issues: [], latencyMs, usageMissing });
        return { ok: true, draft: check.draft, validOnAttempt: attempt, attempts: attempt, model, usage, log };
      }
      repair = check.issues;
      log.push({ outcome: "invalid", issues: check.issues, latencyMs, usageMissing });
    } catch (error) {
      const kind = error instanceof ProviderError ? error.kind : "bad_request";
      log.push({ outcome: kind, issues: [], latencyMs: deps.now() - started, usageMissing: false });
      failure = "provider_error";
      providerErrorKind = kind;
      if (!TRANSIENT_KINDS.has(kind)) return { ok: false, failure, providerErrorKind, issues: repair, attempts: attempt, model, usage, log };
      if (attempt < MAX_ATTEMPTS) await deps.sleep(RETRY_DELAYS_MS[Math.min(transientErrors, RETRY_DELAYS_MS.length - 1)]!);
      transientErrors += 1;
    }
  }
  return { ok: false, failure, providerErrorKind, issues: repair, attempts: MAX_ATTEMPTS, model, usage, log };
}
