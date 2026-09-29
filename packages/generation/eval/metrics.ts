import type { Issue } from "@asksite/core";
import type { EvalRun } from "./run.ts";

export interface CandidateSummary {
  label: string;
  runs: number;
  firstTryPassRate: number;
  passRate: number;
  /** Attempts that broke each rule (an attempt counts once per rule). */
  failedRules: Record<string, number>;
  /** Words the claim checker caught, e.g. "since", "licensed". */
  claimWords: Record<string, number>;
  providerErrors: Record<string, number>;
  latencyMsP50: number;
  latencyMsP95: number;
  maxInputTokensPerRun: number;
  totalCostMicrousd: number;
  costPerPassingSiteMicrousd: number | null;
  /** The automatic half of the proposed gate: >= 95 % pass within 2 retries and >= 80 % first try. */
  meetsAutomaticGate: boolean;
}

/** A short name for the rule an issue broke. */
export function ruleOf(issue: Issue): string {
  if (issue.code === "cut_off" || issue.code === "refused" || issue.code === "incomplete") return issue.code;
  if (issue.code === "too_big" || issue.code === "too_small") return "length";
  if (issue.message.includes("numbers, currency symbols")) return "digits_or_links";
  if (issue.message.includes("facts do not back")) return "unbacked_claim";
  if (issue.message.includes("Latin script")) return "non_latin";
  if (/invisible|control/i.test(issue.message)) return "invisible";
  if (issue.path[0] === "layout") return "layout";
  if (issue.path.includes("serviceDescriptions")) return "service_descriptions";
  return "shape";
}

/** Nearest-rank percentile; 0 for no values. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

const bump = (counts: Record<string, number>, key: string): void => void (counts[key] = (counts[key] ?? 0) + 1);

export function summarise(runs: readonly EvalRun[]): CandidateSummary[] {
  const labels = [...new Set(runs.map((r) => r.candidate))];
  return labels.map((label) => {
    const mine = runs.filter((r) => r.candidate === label);
    const failedRules: Record<string, number> = {};
    const claimWords: Record<string, number> = {};
    const providerErrors: Record<string, number> = {};
    for (const { result } of mine)
      for (const attempt of result.log) {
        if (attempt.outcome === "valid") continue;
        if (attempt.issues.length === 0) bump(providerErrors, attempt.outcome);
        for (const rule of new Set(attempt.issues.map(ruleOf))) bump(failedRules, rule);
        for (const issue of attempt.issues)
          if (ruleOf(issue) === "unbacked_claim") for (const [, word] of issue.message.matchAll(/"([^"]+)"/g)) bump(claimWords, word!.toLowerCase());
      }
    const passes = mine.filter((r) => r.result.ok).length;
    const firstTry = mine.filter((r) => r.result.ok && r.result.validOnAttempt === 1).length;
    const totalCostMicrousd = mine.reduce((sum, r) => sum + r.costMicrousd, 0);
    const firstTryPassRate = mine.length === 0 ? 0 : firstTry / mine.length;
    const passRate = mine.length === 0 ? 0 : passes / mine.length;
    return {
      label,
      runs: mine.length,
      firstTryPassRate,
      passRate,
      failedRules,
      claimWords,
      providerErrors,
      latencyMsP50: percentile(mine.map((r) => r.latencyMs), 0.5),
      latencyMsP95: percentile(mine.map((r) => r.latencyMs), 0.95),
      maxInputTokensPerRun: Math.max(0, ...mine.map((r) => r.result.usage.inputTokens)),
      totalCostMicrousd,
      costPerPassingSiteMicrousd: passes === 0 ? null : Math.round(totalCostMicrousd / passes),
      meetsAutomaticGate: passRate >= 0.95 && firstTryPassRate >= 0.8,
    };
  });
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const usd = (micro: number | null): string => (micro === null ? "n/a" : `$${(micro / 1_000_000).toFixed(4)}`);
const counts = (c: Record<string, number>): string => Object.entries(c).map(([k, v]) => `${k} ${v}`).join(", ") || "none";

export function formatReport(summaries: readonly CandidateSummary[]): string {
  return [
    "# Generation eval",
    "",
    "| model | runs | first try | within 2 retries | p50 ms | p95 ms | cost per passing site | automatic gate |",
    "|---|---|---|---|---|---|---|---|",
    ...summaries.map((s) => `| ${s.label} | ${s.runs} | ${pct(s.firstTryPassRate)} | ${pct(s.passRate)} | ${s.latencyMsP50} | ${s.latencyMsP95} | ${usd(s.costPerPassingSiteMicrousd)} | ${s.meetsAutomaticGate ? "pass" : "fail"} |`),
    "",
    ...summaries.flatMap((s) => [`## ${s.label}`, "", `- Rules broken (attempts): ${counts(s.failedRules)}`, `- Claim words caught: ${counts(s.claimWords)}`, `- Provider errors: ${counts(s.providerErrors)}`, `- Largest input per run: ${s.maxInputTokensPerRun} tokens`, ""]),
    "The automatic gate is >= 95% within 2 retries and >= 80% first try. The human half (blind rating in ratings.csv: no unbacked claim found, mean score within 0.3 of Claude) is the user's step.",
  ].join("\n");
}
