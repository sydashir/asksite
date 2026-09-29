import type { GenerationInputSnapshot } from "@asksite/core";
import { generateDraft, type GenerateDeps, type GenerateResult } from "../src/generate.ts";
import { costMicrousd } from "../src/models.ts";
import type { ModelProvider } from "../src/provider.ts";
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
 * generateDraft loop, prompt and validators the production job uses.
 */
export async function runEval(options: {
  candidates: readonly EvalCandidate[];
  profiles: readonly EvalProfile[];
  runs: number;
  deps: GenerateDeps;
  onRun?: (done: number, total: number) => void;
}): Promise<EvalRun[]> {
  const out: EvalRun[] = [];
  const total = options.candidates.length * options.profiles.length * options.runs;
  for (const candidate of options.candidates)
    for (const profile of options.profiles)
      for (let run = 1; run <= options.runs; run++) {
        const result = await generateDraft(candidate.makeProvider(profile.snapshot), profile.snapshot, options.deps);
        out.push({
          candidate: candidate.label,
          profile,
          run,
          result,
          latencyMs: result.log.reduce((sum, attempt) => sum + attempt.latencyMs, 0),
          costMicrousd: costMicrousd(candidate.provider, candidate.modelId, result.usage),
        });
        options.onRun?.(out.length, total);
      }
  return out;
}
