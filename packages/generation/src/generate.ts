import type { AiDraft, GenerationInputSnapshot, Issue } from "@asksite/core";
import { buildPrompt } from "./prompt.ts";
import { ProviderError, TRANSIENT_KINDS, type ModelProvider, type ModelRequest, type ModelResponse, type ProviderErrorKind } from "./provider.ts";
import { checkDraft } from "./validate.ts";
import { AI_DRAFT_JSON_SCHEMA, toWireSchema } from "./wire-schema.ts";

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
/**
 * Upper bound on the input tokens of one attempt (plan Decision 4); models.ts prices a job's worst
 * case with it. test/models.test.ts proves that the largest prompt the builder can make
 * (eval/caps.ts) fits by UTF-8 bytes. Bytes bound tokens only for a tokenizer that does not
 * normalize the text first [inferred]: NFC or NFKC can make one character several (P3-8, measured on
 * Qwen3.8-27B's NFC tokenizer), so generateDraft checks inputBound before every call. Task 15's
 * --caps-probe measures a real caps prompt on each provider. These two constants live here, not in
 * models.ts, because models.ts imports this file; models.ts re-exports them.
 */
export const MAX_INPUT_TOKENS = 70_000;
/** Room for chat-template and structured-output tokens the provider adds [inferred]. */
export const PROMPT_OVERHEAD_TOKENS = 2_000;

const encoder = new TextEncoder();
const utf8Bytes = (text: string): number => encoder.encode(text).length;

/**
 * The most input tokens one request can cost, as the run-time guard counts them: the UTF-8 bytes of
 * exactly what the adapters send (system, user and toWireSchema(jsonSchema)) in its raw, NFC or NFKC
 * form, whichever is largest, plus PROMPT_OVERHEAD_TOKENS. A byte-level tokenizer makes at most one
 * token per byte of the text it reads, and some normalize the text first: U+1D160 is 4 bytes and 12
 * after NFC, U+FDFA 3 bytes and 33 after NFKC [inferred for tokenizers nobody has measured].
 */
export function inputBound(req: Pick<ModelRequest, "system" | "user" | "jsonSchema">): number {
  const text = req.system + req.user + JSON.stringify(toWireSchema(req.jsonSchema));
  return Math.max(utf8Bytes(text), utf8Bytes(text.normalize("NFC")), utf8Bytes(text.normalize("NFKC"))) + PROMPT_OVERHEAD_TOKENS;
}

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

/**
 * `attempts` counts the provider calls actually sent: an attempt refused before its call (over the
 * input bound, or its deadline already passed) sends nothing and does not count. `validOnAttempt` is
 * the loop's attempt number (1 to MAX_ATTEMPTS) of the valid answer, so an unsent attempt before it
 * still counts there. `inputBoundRefused` is true when the guard refused an attempt's prompt.
 */
interface Common {
  attempts: number;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number };
  log: AttemptRecord[];
  inputBoundRefused: boolean;
}
export type GenerateResult =
  | (Common & { ok: true; draft: AiDraft; validOnAttempt: number })
  | (Common & { ok: false; failure: "provider_error" | "invalid_output"; providerErrorKind: ProviderErrorKind | null; issues: Issue[] });

type StopReason = Exclude<ModelResponse["stop"], "end">;

/** Each message describes the problem, never gives an order: the repair intro tells the model to treat it as data. */
const STOP_ISSUE: Record<StopReason, Omit<Issue, "path">> = {
  max_tokens: { code: "cut_off", message: "Your last answer was too long and was cut off before it ended." },
  refusal: { code: "refused", message: "Your last answer was a refusal, not wording for this business." },
  other: { code: "incomplete", message: "Your last answer ended before the whole answer was sent." },
};

/** A new issue on every call: a caller may edit the issues it gets back, and a later job must not see that. */
const stopIssue = (stop: StopReason): Issue => ({ path: [], ...STOP_ISSUE[stop] });

const attemptTimedOut = (): ProviderError => new ProviderError("timeout", "The attempt ran out of time");

/**
 * An error thrown or rejected by provider.generate, as a ProviderError. A ProviderError keeps its
 * kind. Any other error once the signal has aborted is a timeout: a provider may throw or reject with
 * the signal's raw reason (an AbortError or TimeoutError), and whether that or our own timeout wins
 * the race depends on which abort listener runs first. Any other error before that is an unexpected
 * provider failure: a bad request, never retried. Only the provider call's errors come here.
 */
const fromProvider = (error: unknown, signal: AbortSignal): ProviderError => {
  if (error instanceof ProviderError) return error;
  return signal.aborted ? attemptTimedOut() : new ProviderError("bad_request", "The provider call failed with an unexpected error");
};

/**
 * The provider's answer, or a timeout once the request's signal aborts, whichever comes first, so
 * the attempt limit holds even for a provider that ignores the signal. It calls the provider once and
 * throws only ProviderErrors. The call that loses may still reject later; that is never an unhandled
 * rejection. The abort listener is removed as soon as the attempt ends.
 */
async function answerWithinLimit(provider: ModelProvider, req: ModelRequest): Promise<ModelResponse> {
  const { signal } = req;
  let call: Promise<ModelResponse>;
  try {
    call = provider.generate(req);
  } catch (error) {
    throw fromProvider(error, signal);
  }
  call.catch(() => {});
  let onAbort = (): void => {};
  const timedOut = new Promise<never>((_, reject) => {
    onAbort = () => reject(attemptTimedOut());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([call, timedOut]);
  } catch (error) {
    // The race rejects only with the call's own error or with our timeout, which is a ProviderError.
    throw fromProvider(error, signal);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Up to MAX_ATTEMPTS model calls (design §6.3). Each answer is validated with checkDraft; a failed
 * check sends its issues back as repair feedback. An attempt that outlasts ATTEMPT_TIMEOUT_MS is a
 * timeout. Transient provider errors pause 2 s then 6 s; auth and bad-request errors stop at once.
 * Only the provider call's errors are recorded as provider errors. An exception from our own code
 * (buildPrompt, timeoutSignal, usage accounting, checkDraft) is a bug: it propagates, so the job
 * reports it as internal instead of hiding it as a provider rejection. Shared by the queue job and
 * the eval.
 */
export async function generateDraft(provider: ModelProvider, snapshot: GenerationInputSnapshot, deps: GenerateDeps = REAL_DEPS): Promise<GenerateResult> {
  const usage = { inputTokens: 0, outputTokens: 0 };
  const log: AttemptRecord[] = [];
  let model: string | null = null;
  let repair: Issue[] = [];
  let failure: "provider_error" | "invalid_output" = "invalid_output";
  let providerErrorKind: ProviderErrorKind | null = null;
  let transientErrors = 0;
  let calls = 0;
  let inputBoundRefused = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { system, user } = buildPrompt(snapshot, repair);
    const req: ModelRequest = { system, user, jsonSchema: AI_DRAFT_JSON_SCHEMA, maxOutputTokens: MAX_OUTPUT_TOKENS, signal: deps.timeoutSignal(ATTEMPT_TIMEOUT_MS) };
    const started = deps.now();
    let res: ModelResponse;
    try {
      // Checked on exactly what this call would send. No retry can shrink the prompt, so it is a bad request.
      if (inputBound(req) > MAX_INPUT_TOKENS) {
        inputBoundRefused = true;
        throw new ProviderError("bad_request", "prompt over the input bound");
      }
      // A request sent after the deadline is a paid call whose answer would be thrown away.
      if (req.signal.aborted) throw attemptTimedOut();
      calls += 1;
      res = await answerWithinLimit(provider, req);
    } catch (error) {
      // Only the two checks above and answerWithinLimit throw ProviderErrors; anything else is a bug in our own code and propagates.
      if (!(error instanceof ProviderError)) throw error;
      const kind = error.kind;
      log.push({ outcome: kind, issues: [], latencyMs: deps.now() - started, usageMissing: false });
      failure = "provider_error";
      providerErrorKind = kind;
      if (!TRANSIENT_KINDS.has(kind)) return { ok: false, failure, providerErrorKind, issues: repair, attempts: calls, model, usage, log, inputBoundRefused };
      if (attempt < MAX_ATTEMPTS) await deps.sleep(RETRY_DELAYS_MS[Math.min(transientErrors, RETRY_DELAYS_MS.length - 1)]!);
      transientErrors += 1;
      continue;
    }
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
      return { ok: true, draft: check.draft, validOnAttempt: attempt, attempts: calls, model, usage, log, inputBoundRefused };
    }
    repair = check.issues;
    log.push({ outcome: "invalid", issues: check.issues, latencyMs, usageMissing });
  }
  return { ok: false, failure, providerErrorKind, issues: repair, attempts: calls, model, usage, log, inputBoundRefused };
}
