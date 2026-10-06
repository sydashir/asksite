import type { AiDraft, GenerationInputSnapshot, Issue } from "@asksite/core";
import { wellFormed } from "./model-facts.ts";
import { buildPrompt, MAX_ISSUE_MESSAGE, MAX_ISSUE_PATH, MAX_REPAIR_ISSUES } from "./prompt.ts";
import { ProviderError, TRANSIENT_KINDS, type ModelProvider, type ModelRequest, type ModelResponse, type ProviderErrorKind } from "./provider.ts";
import { checkDraft } from "./validate.ts";
import { AI_DRAFT_JSON_SCHEMA, toWireSchema } from "./wire-schema.ts";

/** Design §6.3 constants. */
export const MAX_ATTEMPTS = 3;
export const ATTEMPT_TIMEOUT_MS = 90_000;
/** Pause before the attempt that follows the 1st and the 2nd transient provider error. */
export const RETRY_DELAYS_MS = [2_000, 6_000] as const;
/** The longest pause a provider's Retry-After can make before the next attempt; it replaces the fixed pause when the provider sent one. */
export const MAX_RETRY_AFTER_MS = 30_000;
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
 * Adding NFD or NFKD here is a deliberate decision that needs measured evidence. NFD would refuse
 * schema-valid, caps-filled Hangul, Kannada and accented Greek (up to 9 bytes per UTF-16 unit: U+D7A3
 * is 3 bytes and 9 after NFD; generate.test.ts pins that such a Hangul snapshot is sent), and no
 * candidate tokenizer is known to decompose: gpt-oss has no normalizer, Qwen3.8 uses NFC and Gemma 4
 * only replaces spaces (their tokenizer.json files, checked 2026-09-27); Claude's is unknown until
 * Task 15 counts real tokens (count_tokens).
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
 * A path cut to MAX_ISSUE_PATH UTF-16 units as a repair line writes it (keys joined with "."), kept a
 * list so a reader can still match its keys: a key that crosses the cut keeps its first units, an
 * index that crosses it is dropped. Each kept key is made well-formed.
 */
function cutPath(path: ReadonlyArray<string | number>): Array<string | number> {
  const kept: Array<string | number> = [];
  let room = MAX_ISSUE_PATH;
  for (const key of path) {
    const separator = kept.length > 0 ? 1 : 0;
    const length = String(key).length;
    if (separator + length <= room) {
      kept.push(typeof key === "string" ? wellFormed(key) : key);
      room -= separator + length;
      continue;
    }
    if (typeof key === "string" && room - separator > 0) kept.push(wellFormed(key.slice(0, room - separator)));
    break;
  }
  return kept;
}

/**
 * Issues as the attempt log and the result keep them, capped like the repair lines (prompt.ts): the
 * first MAX_REPAIR_ISSUES, each path cut to MAX_ISSUE_PATH and each message to MAX_ISSUE_MESSAGE UTF-16
 * units, then made well-formed. A hostile answer can make thousands of issues, and Zod's "Unrecognized
 * key" message repeats a model-chosen key of any length. Returns new issues; never mutates its input.
 */
export function capIssues(issues: readonly Issue[]): Issue[] {
  return issues.slice(0, MAX_REPAIR_ISSUES).map(({ path, code, message }) => ({ path: cutPath(path), code, message: wellFormed(message.slice(0, MAX_ISSUE_MESSAGE)) }));
}

/**
 * An error thrown or rejected by provider.generate, as a ProviderError. A ProviderError keeps its
 * kind. Any other error once the signal has aborted is a timeout: a provider may throw or reject with
 * the signal's raw reason (an AbortError or TimeoutError), and whether that or our own timeout wins
 * the race depends on which abort listener runs first. Any other error before that is an unexpected
 * provider failure: a bad request, never retried. Only the provider call's errors come here, and our
 * own timeout from the race, which is a ProviderError and passes through unchanged.
 */
const fromProvider = (error: unknown, signal: AbortSignal): ProviderError => {
  if (error instanceof ProviderError) return error;
  return signal.aborted ? attemptTimedOut() : new ProviderError("bad_request", "The provider call failed with an unexpected error");
};

/**
 * The provider's answer, or a timeout once the request's signal aborts, whichever comes first, so
 * the attempt limit holds even for a provider that ignores the signal. It calls the provider once and
 * throws only ProviderErrors. The abort event fires only once, so a signal that aborted while the
 * provider's synchronous part ran is a timeout at once, never a wait for an event that already fired.
 * The call that loses may still reject later; Promise.race has handled it, so that is never an
 * unhandled rejection. The abort listener is removed as soon as the attempt ends.
 */
async function answerWithinLimit(provider: ModelProvider, req: ModelRequest): Promise<ModelResponse> {
  const { signal } = req;
  let call: Promise<ModelResponse>;
  try {
    call = provider.generate(req);
  } catch (error) {
    throw fromProvider(error, signal);
  }
  let onAbort = (): void => {};
  const timedOut = new Promise<never>((_, reject) => {
    onAbort = () => reject(attemptTimedOut());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
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
 * timeout, and so is one whose deadline passed before its call (nothing is sent). A prompt over the
 * input bound (inputBound) is refused before its call as a bad request; when an earlier answer's repair
 * lines grew it, the failure is invalid_output (P3-18), with providerErrorKind null. Transient provider errors
 * pause by the provider's Retry-After (at most 30 s) or else 2 s then 6 s; auth and bad-request errors stop at once. Only these are recorded as provider
 * errors: the provider call's own errors, our timeouts and the input-bound refusal. An exception from
 * our own code (buildPrompt, timeoutSignal, the bound's measurement, usage accounting, checkDraft) is
 * a bug: it propagates instead of being hidden as a provider rejection. The job treats it as an
 * unexpected error (plan Decision 24): a regeneration fails with internal, and a first build gets the
 * template draft with fallback reason provider_error. Shared by the queue job and the eval.
 *
 * The pause before a retry is the provider's Retry-After (whole seconds, at most MAX_RETRY_AFTER_MS) when it sent one, else
 * RETRY_DELAYS_MS. `deadline`, when given, is the time (deps.now()'s clock) by which the whole job must be over: the job passes
 * its started_at plus JOB_STUCK_AFTER_MS less a margin, so time spent before this call counts. An attempt that could not finish
 * by it (its pause plus ATTEMPT_TIMEOUT_MS) is not started, so the sweeper never ends a job that is still paying for a call.
 * Nothing is sent for it: it is not an attempt and not an attempt outcome. The job ends with what the last attempt left: a
 * provider error keeps its kind, an invalid answer stays invalid_output, and only a job that sent nothing is a timeout.
 */
export async function generateDraft(provider: ModelProvider, snapshot: GenerationInputSnapshot, deps: GenerateDeps = REAL_DEPS, deadline?: number): Promise<GenerateResult> {
  const fitsInBudget = (pauseMs: number): boolean => deadline === undefined || deps.now() + pauseMs + ATTEMPT_TIMEOUT_MS <= deadline;
  const usage = { inputTokens: 0, outputTokens: 0 };
  const log: AttemptRecord[] = [];
  let model: string | null = null;
  let repair: Issue[] = [];
  let failure: "provider_error" | "invalid_output" = "invalid_output";
  let providerErrorKind: ProviderErrorKind | null = null;
  let transientErrors = 0;
  let calls = 0;
  let inputBoundRefused = false;
  /** An earlier attempt was sent and answered; not validly, since a valid answer returns at once. */
  let answered = false;
  /** The deadline leaves no room for the next attempt: end with what the last one left (a job that sent nothing is a timeout). */
  const endedByBudget = (): GenerateResult => {
    if (log.length === 0) {
      failure = "provider_error";
      providerErrorKind = "timeout";
    }
    return { ok: false, failure, providerErrorKind, issues: capIssues(repair), attempts: calls, model, usage, log, inputBoundRefused };
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (!fitsInBudget(0)) return endedByBudget();
    const { system, user } = buildPrompt(snapshot, repair);
    const req: ModelRequest = { system, user, jsonSchema: AI_DRAFT_JSON_SCHEMA, maxOutputTokens: MAX_OUTPUT_TOKENS, signal: deps.timeoutSignal(ATTEMPT_TIMEOUT_MS) };
    const started = deps.now();
    let sent = false;
    let refused = false;
    let res: ModelResponse;
    try {
      // Checked on exactly what this call would send. On attempt 1 an overflow can come only from owner text; on
      // attempts 2 and 3 it can also come from the model's own text, which reaches the prompt through the repair
      // lines (Zod's "Unrecognized key" message repeats a key the model chose). No retry can shrink the prompt, so
      // it is a bad request.
      if (inputBound(req) > MAX_INPUT_TOKENS) {
        inputBoundRefused = true;
        refused = true;
        throw new ProviderError("bad_request", "prompt over the input bound");
      }
      // A request sent after the deadline is a paid call whose answer would be thrown away.
      if (req.signal.aborted) throw attemptTimedOut();
      sent = true;
      calls += 1;
      res = await answerWithinLimit(provider, req);
    } catch (error) {
      // Only the two checks above and answerWithinLimit throw ProviderErrors. Anything else is a bug in our own code: it propagates.
      if (!(error instanceof ProviderError)) throw error;
      const kind = error.kind;
      // A call that was sent and then timed out, failed after a 2xx status line (afterHeaders) or failed with no status
      // line at all (noResponse, P3-16 fix 5) may still be billed, and its usage is unknown: never a silent 0. Failures
      // before the connection (DNS, a refused connection) are over-reported as unknown on purpose (conservative; they
      // cost nothing). A non-2xx status stays a refusal, treated as not billed (P3-14).
      const unknown = kind === "timeout" || error.afterHeaders === true || error.noResponse === true;
      log.push({ outcome: kind, issues: [], latencyMs: deps.now() - started, usageMissing: sent && unknown });
      // P3-18: once an answer was not valid, its repair lines grew this prompt, so a refusal by the guard is the model's
      // failure (invalid_output: a regeneration then counts toward the owner's total, P3-16 (B)), not the provider's.
      // providerErrorKind is null, as for every invalid_output; the refusal stays recorded in this attempt's outcome
      // (bad_request) and inputBoundRefused (true).
      failure = refused && answered ? "invalid_output" : "provider_error";
      providerErrorKind = failure === "invalid_output" ? null : kind;
      if (!TRANSIENT_KINDS.has(kind)) return { ok: false, failure, providerErrorKind, issues: capIssues(repair), attempts: calls, model, usage, log, inputBoundRefused };
      if (attempt < MAX_ATTEMPTS) {
        const pause = error.retryAfterSeconds === undefined ? RETRY_DELAYS_MS[Math.min(transientErrors, RETRY_DELAYS_MS.length - 1)]! : Math.min(error.retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS);
        // The next attempt cannot finish in the budget: end now instead of waiting for it to be refused.
        if (!fitsInBudget(pause)) return endedByBudget();
        await deps.sleep(pause);
      }
      transientErrors += 1;
      continue;
    }
    const latencyMs = deps.now() - started;
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    model = res.model;
    answered = true;
    failure = "invalid_output";
    providerErrorKind = null;
    const usageMissing = res.usageMissing === true;
    if (res.stop !== "end") {
      // Adapters map an unknown stop reason to "other"; a value outside the contract is treated the same.
      const stop = Object.hasOwn(STOP_ISSUE, res.stop) ? res.stop : "other";
      repair = [stopIssue(stop)];
      log.push({ outcome: stop, issues: capIssues(repair), latencyMs, usageMissing });
      continue;
    }
    const check = checkDraft(snapshot.facts, res.json);
    if (check.ok) {
      log.push({ outcome: "valid", issues: [], latencyMs, usageMissing });
      return { ok: true, draft: check.draft, validOnAttempt: attempt, attempts: calls, model, usage, log, inputBoundRefused };
    }
    // repair keeps every issue: buildPrompt makes its own capped lines from it.
    repair = check.issues;
    log.push({ outcome: "invalid", issues: capIssues(check.issues), latencyMs, usageMissing });
  }
  return { ok: false, failure, providerErrorKind, issues: capIssues(repair), attempts: calls, model, usage, log, inputBoundRefused };
}
