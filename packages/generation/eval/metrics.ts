import type { Issue } from "@asksite/core";
import { describeStop, formatUsd, type BudgetStop } from "./budget.ts";
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
  /** Attempts whose provider left the usage out (usageMissing): the costs above cannot include them. */
  usageMissingAttempts: number;
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
      usageMissingAttempts: mine.reduce((sum, r) => sum + r.result.log.filter((attempt) => attempt.usageMissing).length, 0),
      meetsAutomaticGate: passRate >= 0.95 && firstTryPassRate >= 0.8,
    };
  });
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const usd = (micro: number | null): string => (micro === null ? "n/a" : `$${(micro / 1_000_000).toFixed(4)}`);
const counts = (c: Record<string, number>): string => Object.entries(c).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
/** What a cost is when a provider left the usage of some attempts out (additions B). */
const unknownCost = (attempts: number): string => `unknown (${attempts} ${attempts === 1 ? "attempt" : "attempts"} without usage)`;

/** What a live run spent (amendment P3-17): its budget, what the budget counted, and whether it stopped the run. */
export interface SpendReport {
  budgetMicrousd: number;
  /** Actual costs, and the worst case of each site that has an attempt without usage. */
  countedMicrousd: number;
  stop: BudgetStop | null;
}

const spent = (label: string, micro: number, missing: number): string => `- ${label}: spent ${formatUsd(micro)}${missing === 0 ? "" : `, plus ${unknownCost(missing)}`}`;

function spendSection(summaries: readonly CandidateSummary[], spend: SpendReport): string[] {
  const total = summaries.reduce((sum, s) => sum + s.totalCostMicrousd, 0);
  const missing = summaries.reduce((sum, s) => sum + s.usageMissingAttempts, 0);
  return [
    "## Spend",
    "",
    `- Budget: ${formatUsd(spend.budgetMicrousd)}. Counted against it: ${formatUsd(spend.countedMicrousd)} (a site with an attempt without usage counts at its worst case).`,
    ...summaries.map((s) => spent(s.label, s.totalCostMicrousd, s.usageMissingAttempts)),
    spent("In total", total, missing),
    `- ${describeStop(spend.stop)}`,
    "",
  ];
}

/** The report; with `spend` (a live run), also what it spent against its budget. */
export function formatReport(summaries: readonly CandidateSummary[], spend?: SpendReport): string {
  return [
    "# Generation eval",
    "",
    "| model | runs | first try | within 2 retries | p50 ms | p95 ms | cost per passing site | automatic gate |",
    "|---|---|---|---|---|---|---|---|",
    ...summaries.map((s) => `| ${s.label} | ${s.runs} | ${pct(s.firstTryPassRate)} | ${pct(s.passRate)} | ${s.latencyMsP50} | ${s.latencyMsP95} | ${s.usageMissingAttempts === 0 ? usd(s.costPerPassingSiteMicrousd) : unknownCost(s.usageMissingAttempts)} | ${s.meetsAutomaticGate ? "pass" : "fail"} |`),
    "",
    ...summaries.flatMap((s) => [`## ${s.label}`, "", `- Rules broken (attempts): ${counts(s.failedRules)}`, `- Claim words caught: ${counts(s.claimWords)}`, `- Provider errors: ${counts(s.providerErrors)}`, `- Largest input per run: ${s.maxInputTokensPerRun} tokens`, ""]),
    ...(spend === undefined ? [] : spendSection(summaries, spend)),
    "The automatic gate is >= 95% within 2 retries and >= 80% first try. The human half (blind rating in ratings.csv: no unbacked claim found, mean score within 0.3 of Claude) is the user's step.",
  ].join("\n");
}
