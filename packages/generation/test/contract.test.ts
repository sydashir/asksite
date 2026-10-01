import type { GenerationInputSnapshot, GenerationJob, GenerationRow, GenerationView } from "@asksite/core";
import type { D1Database, Queue } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import * as api from "../src/index.ts";

// Design §6.4, written out (worstCaseJobMicrousd with Decision 11). If a signature drifts,
// `pnpm typecheck` fails on this assignment. Properties, not methods: method parameters are
// compared bivariantly, so a changed parameter type would slip through.
interface Contract {
  requestGeneration: (
    env: { DB: D1Database; GEN_QUEUE: Queue<GenerationJob>; GENERATION_ENABLED: string; DAILY_MODEL_LIMIT: string },
    input: { siteId: string; ownerId: string; snapshot: GenerationInputSnapshot; now: number },
  ) => Promise<
    | { ok: true; generation: GenerationView }
    | { ok: false; code: "generation_in_progress" | "generation_cap_reached" | "generation_disabled" | "budget_exhausted" | "internal" }
  >;
  generationAllowance: (env: { DB: D1Database }, input: { siteId: string; ownerId: string; now: number }) => Promise<{ generationsLeftToday: number; generationsLeftTotal: number }>;
  isGenerationEnabled: (env: { DB: D1Database; GENERATION_ENABLED: string }) => Promise<boolean>;
  dailyModelLimit: (env: { DB: D1Database; DAILY_MODEL_LIMIT: string }) => Promise<number>;
  worstCaseJobMicrousd: (provider: string, modelId: string) => number | null;
  toGenerationView: (row: GenerationRow) => GenerationView;
}
const contract: Contract = api;

describe("@asksite/generation public API", () => {
  it("exports every function design §6.4 promises Plan 4", () => {
    for (const name of Object.keys({ requestGeneration: 0, generationAllowance: 0, isGenerationEnabled: 0, dailyModelLimit: 0, worstCaseJobMicrousd: 0, toGenerationView: 0 }))
      expect(typeof (contract as unknown as Record<string, unknown>)[name]).toBe("function");
  });

  it("exports what the generator Worker runs", () => {
    expect([typeof api.runGenerationJob, typeof api.sweepStuckJobs, typeof api.templateDraft, typeof api.toModelFacts]).toEqual(["function", "function", "function", "function"]);
  });

  // Task 11 additions A: export only what Task 11 lists. Provider internals (design 6.2) and test support stay
  // unexported. Types are erased at runtime, so this checks the value exports only.
  it("exports no other value", () => {
    expect(Object.keys(api).sort()).toEqual([
      "JOB_STUCK_AFTER_MS",
      "dailyModelLimit",
      "generationAllowance",
      "isGenerationEnabled",
      "requestGeneration",
      "runGenerationJob",
      "sweepStuckJobs",
      "templateDraft",
      "toGenerationView",
      "toModelFacts",
      "worstCaseJobMicrousd",
    ]);
  });
});
