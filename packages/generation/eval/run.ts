import type { GenerationInputSnapshot } from "@asksite/core";
import { generateDraft, type GenerateDeps, type GenerateResult } from "../src/generate.ts";
import { worstCaseJobMicrousd } from "../src/models.ts";
import type { ModelProvider } from "../src/provider.ts";
import { usageCostMicrousd, type Budget } from "./budget.ts";
import type { EvalProfile } from "./profiles.ts";

export interface EvalCandidate {
  label: string;
  provider: string;
  modelId: string;
  makeProvider(snapshot: GenerationInputSnapshot): ModelProvider;
}

export interface EvalRun {
  candidate: string;
  profile: EvalProfile;
  run: number;
  result: GenerateResult;
  latencyMs: number;
  costMicrousd: number;
}

/**
 * Every candidate x profile x run, one after another (gentle on rate limits), through the same
 * generateDraft loop, prompt and validators the production job uses. With a budget (a live run,
 * amendment P3-17), each site is sent only while its worst case (worstCaseJobMicrousd) still fits,
 * and a site with an attempt without usage, or a cost or usage it cannot count, counts at that worst
 * case; once the budget stops, no further site of any candidate is sent, and the runs so far are
 * returned. onRun gets each run as it completes, so a caller keeps what completed even when an
 * exception ends the evaluation early.
 */
export async function runEval(options: {
  candidates: readonly EvalCandidate[];
  profiles: readonly EvalProfile[];
  runs: number;
  deps: GenerateDeps;
  onRun?: (done: number, total: number, run: EvalRun) => void;
  budget?: Budget;
}): Promise<EvalRun[]> {
  const out: EvalRun[] = [];
  const total = options.candidates.length * options.profiles.length * options.runs;
  for (const candidate of options.candidates) {
    const worst = worstCaseJobMicrousd(candidate.provider, candidate.modelId);
    for (const profile of options.profiles)
      for (let run = 1; run <= options.runs; run++) {
        const site = () => generateDraft(candidate.makeProvider(profile.snapshot), profile.snapshot, options.deps);
        const costOf = (sent: GenerateResult) => ({ actualMicrousd: usageCostMicrousd(candidate.provider, candidate.modelId, sent.usage), usageMissing: sent.log.some((attempt) => attempt.usageMissing) });
        const result = options.budget === undefined ? await site() : await options.budget.send(`${candidate.label} ${profile.id} run ${run}`, worst, site, costOf);
        if (result === undefined) return out;
        const completed: EvalRun = {
          candidate: candidate.label,
          profile,
          run,
          result,
          latencyMs: result.log.reduce((sum, attempt) => sum + attempt.latencyMs, 0),
          // NaN when the usage cannot be counted: the report then shows the worst case the budget counted instead.
          costMicrousd: usageCostMicrousd(candidate.provider, candidate.modelId, result.usage),
        };
        out.push(completed);
        options.onRun?.(out.length, total, completed);
      }
  }
  return out;
}
