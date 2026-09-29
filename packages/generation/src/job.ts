import type { AiDraft, FallbackReason, GenerationErrorCode, GenerationInputSnapshot } from "@asksite/core";
import type { D1Database } from "@cloudflare/workers-types";
import { generateDraft, REAL_DEPS, type AttemptOutcome, type GenerateDeps } from "./generate.ts";
import { costMicrousd } from "./models.ts";
import { ProviderError, type ModelProvider, type ProviderErrorKind } from "./provider.ts";
import { createProvider, type ProviderEnv } from "./providers/create.ts";
import { dailyModelLimit, isGenerationEnabled, utcDayStart } from "./settings.ts";
import { parseSnapshot } from "./snapshot.ts";
import { templateDraft } from "./template.ts";

export interface JobEnv extends ProviderEnv {
  DB: D1Database;
  GENERATION_ENABLED: string;
  DAILY_MODEL_LIMIT: string;
}

export interface JobDeps {
  now(): number;
  generate: GenerateDeps;
  createProvider(env: ProviderEnv, snapshot: GenerationInputSnapshot): ModelProvider;
}

export const JOB_DEPS: JobDeps = { now: () => Date.now(), generate: REAL_DEPS, createProvider };

/** For the Worker's one log line: IDs and codes only, never owner text, prompts or keys. */
export interface JobReport {
  outcome: "not_claimed" | "succeeded" | "fallback" | "failed" | "lost" | "write_failed" | "read_failed";
  generationId: string;
  attempts: number;
  usedFallback: boolean;
  errorCode: GenerationErrorCode | null;
  fallbackReason: FallbackReason | null;
  /** Why the provider failed ("auth" for a missing, wrong or revoked key), or null. */
  providerErrorKind: ProviderErrorKind | null;
  /** Each attempt's outcome code, in order. */
  attemptOutcomes: AttemptOutcome[];
  /** An attempt's usage is unknown and counted as 0: the provider sent none, or a sent call that may be billed failed (P3-4a). */
  usageMissing: boolean;
  /** The input-bound guard refused an attempt's prompt before its call (P3-8). */
  inputBoundRefused: boolean;
  durationMs: number;
}

// §6.3 step 1: one statement claims the job AND, if the kill switch is on and today's count is
// under the limit, one of today's model calls. Exact under concurrent consumers.
const CLAIM = `UPDATE generations
SET status = 'running', started_at = ?2,
    model_slot = CASE WHEN ?3 = 1
                       AND (SELECT COUNT(*) FROM generations WHERE model_slot = 1 AND started_at >= ?4) < ?5
                      THEN 1 ELSE 0 END
WHERE id = ?1 AND status = 'queued'`;

// §6.3 step 4: conditional on 'running', so a late or duplicate invocation never overwrites the
// sweeper. A job that sent no provider call gives its model slot back, so a broken configuration
// cannot use up the day's model calls: the provider could not be built (e.g. no key), or the input
// guard or a passed deadline stopped every attempt before its call (attempts counts calls sent).
const FINISH = `UPDATE generations
SET status = ?2, output_json = ?3, used_fallback = ?4, fallback_reason = ?5, error_code = ?6, provider = ?7, model = ?8,
    attempts = ?9, input_tokens = ?10, output_tokens = ?11, cost_microusd = ?12, finished_at = ?13,
    model_slot = CASE WHEN ?9 = 0 THEN 0 ELSE model_slot END
WHERE id = ?1 AND status = 'running'`;

interface Spend {
  provider: string | null;
  model: string | null;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}
const NO_SPEND: Spend = { provider: null, model: null, attempts: 0, inputTokens: 0, outputTokens: 0, cost: 0 };

/** What the log line needs about the model calls. */
interface Trace {
  providerErrorKind: ProviderErrorKind | null;
  attemptOutcomes: AttemptOutcome[];
  usageMissing: boolean;
  inputBoundRefused: boolean;
}
const NO_TRACE: Trace = { providerErrorKind: null, attemptOutcomes: [], usageMissing: false, inputBoundRefused: false };

type Ending =
  | { status: "succeeded"; draft: AiDraft; fallbackReason: FallbackReason | null }
  | { status: "failed"; errorCode: GenerationErrorCode };

type ModelOutcome =
  | { ok: true; draft: AiDraft; spend: Spend; trace: Trace }
  | { ok: false; reason: FallbackReason; timedOut: boolean; spend: Spend; trace: Trace };

/** §6.3 steps 2 and 3: no model call without a slot; otherwise up to MAX_ATTEMPTS validated attempts. */
async function callModel(env: JobEnv, snapshot: GenerationInputSnapshot, hasSlot: boolean, enabled: boolean, deps: JobDeps): Promise<ModelOutcome> {
  if (!hasSlot) return { ok: false, reason: enabled ? "budget" : "disabled", timedOut: false, spend: NO_SPEND, trace: NO_TRACE };
  let provider: ModelProvider;
  try {
    provider = deps.createProvider(env, snapshot);
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return { ok: false, reason: "provider_error", timedOut: false, spend: { ...NO_SPEND, provider: env.MODEL_PROVIDER }, trace: { ...NO_TRACE, providerErrorKind: error.kind } };
  }
  const result = await generateDraft(provider, snapshot, deps.generate);
  const spend: Spend = {
    provider: env.MODEL_PROVIDER,
    model: result.model ?? env.MODEL_ID,
    attempts: result.attempts,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cost: costMicrousd(env.MODEL_PROVIDER, env.MODEL_ID, result.usage),
  };
  const trace: Trace = {
    providerErrorKind: result.ok ? null : result.providerErrorKind,
    attemptOutcomes: result.log.map((attempt) => attempt.outcome),
    usageMissing: result.log.some((attempt) => attempt.usageMissing),
    inputBoundRefused: result.inputBoundRefused,
  };
  if (result.ok) return { ok: true, draft: result.draft, spend, trace };
  return { ok: false, reason: result.failure, timedOut: result.providerErrorKind === "timeout", spend, trace };
}

const REGENERATE_CODE: Record<FallbackReason, GenerationErrorCode> = {
  disabled: "generation_disabled",
  budget: "budget_exhausted",
  provider_error: "provider_unavailable",
  invalid_output: "invalid_output",
};

/** A first build's fallback (§6.3): the template, or failed/internal only if the template itself cannot be made. */
function templateEnding(snapshot: GenerationInputSnapshot, reason: FallbackReason): Ending {
  try {
    return { status: "succeeded", draft: templateDraft(snapshot.facts, snapshot.brief), fallbackReason: reason };
  } catch {
    return { status: "failed", errorCode: "internal" };
  }
}

type JobRow = { kind: "first" | "regenerate"; input_json: string; model_slot: 0 | 1 };

/**
 * The queue job for one generation (design §6.3). After the claim it never throws: every path
 * ends in one conditional terminal write, or leaves the running row to the sweeper. A first build
 * that gets no valid model output falls back to templateDraft; a regeneration fails and leaves
 * the owner's current wording alone.
 */
export async function runGenerationJob(env: JobEnv, generationId: string, deps: JobDeps = JOB_DEPS): Promise<JobReport> {
  const startedAt = deps.now();
  const report = (outcome: JobReport["outcome"], extra: Partial<JobReport> = {}): JobReport => ({
    outcome, generationId, attempts: 0, usedFallback: false, errorCode: null, fallbackReason: null,
    providerErrorKind: null, attemptOutcomes: [], usageMissing: false, inputBoundRefused: false,
    durationMs: deps.now() - startedAt, ...extra,
  });

  const enabled = await isGenerationEnabled(env);
  const limit = await dailyModelLimit(env);
  const claim = await env.DB.prepare(CLAIM).bind(generationId, startedAt, enabled ? 1 : 0, utcDayStart(startedAt), limit).run();
  if (claim.meta.changes !== 1) return report("not_claimed");

  let row: JobRow | null;
  try {
    row = await env.DB.prepare("SELECT kind, input_json, model_slot FROM generations WHERE id = ?1").bind(generationId).first<JobRow>();
  } catch {
    return report("read_failed"); // still 'running': the sweeper ends it (a first build gets the template)
  }
  const snapshot = row === null ? null : parseSnapshot(row.input_json);

  let ending: Ending;
  let spend = NO_SPEND;
  let trace = NO_TRACE;
  if (row === null || snapshot === null) {
    ending = { status: "failed", errorCode: "internal" };
  } else {
    const kind = row.kind;
    try {
      const model = await callModel(env, snapshot, row.model_slot === 1, enabled, deps);
      spend = model.spend;
      trace = model.trace;
      if (model.ok) ending = { status: "succeeded", draft: model.draft, fallbackReason: null };
      else if (kind === "first") ending = templateEnding(snapshot, model.reason);
      else ending = { status: "failed", errorCode: model.timedOut ? "provider_timeout" : REGENERATE_CODE[model.reason] };
    } catch {
      // Something unexpected (a bug, not a provider answer): a first build still gets its draft.
      ending = kind === "first" ? templateEnding(snapshot, "provider_error") : { status: "failed", errorCode: "internal" };
    }
  }

  const fallbackReason = ending.status === "succeeded" ? ending.fallbackReason : null;
  const errorCode = ending.status === "failed" ? ending.errorCode : null;
  const calls = { attempts: spend.attempts, ...trace };
  try {
    const finish = await env.DB.prepare(FINISH)
      .bind(
        generationId,
        ending.status,
        ending.status === "succeeded" ? JSON.stringify(ending.draft) : null,
        fallbackReason === null ? 0 : 1,
        fallbackReason,
        errorCode,
        spend.provider,
        spend.model,
        spend.attempts,
        spend.inputTokens,
        spend.outputTokens,
        spend.cost,
        deps.now(),
      )
      .run();
    if (finish.meta.changes !== 1) return report("lost", calls);
  } catch {
    return report("write_failed", calls);
  }
  const outcome = ending.status === "failed" ? "failed" : fallbackReason === null ? "succeeded" : "fallback";
  return report(outcome, { ...calls, usedFallback: fallbackReason !== null, errorCode, fallbackReason });
}
