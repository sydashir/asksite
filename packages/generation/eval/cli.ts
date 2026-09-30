// pnpm eval:generation [--live --max-usd <US$>] [--runs 1-10] [--only label,label] [--caps-probe | --record]
//
// A dry run unless both --live and --max-usd are given (amendment P3-17): it prints each model's worst-case cost and
// whether its key is present, builds no provider and sends nothing. A live run (the evaluation, --caps-probe or
// --record) sends each request only while the spend so far plus its worst case still fits under --max-usd
// (budget.ts), cheapest model first. Keys come only from the environment: the package script runs
// `node --env-file-if-exists=../../.env`, so a .env holding keys at the repo root is what makes a live run possible.
// Never prints a key, nor any argument as it was typed.
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ATTEMPT_TIMEOUT_MS, MAX_ATTEMPTS, MAX_OUTPUT_TOKENS, REAL_DEPS, type GenerateDeps } from "../src/generate.ts";
import { costMicrousd, MAX_INPUT_TOKENS, worstCaseJobMicrousd } from "../src/models.ts";
import { buildPrompt } from "../src/prompt.ts";
import { ProviderError, type ModelResponse } from "../src/provider.ts";
import { createProvider, type ProviderEnv } from "../src/providers/create.ts";
import { AI_DRAFT_JSON_SCHEMA } from "../src/wire-schema.ts";
import { Budget, CAPS_PROBE_OUTPUT_TOKENS, describeStop, formatUsd, parseMaxUsd, requestWorstCaseMicrousd, type RequestCost } from "./budget.ts";
import { CAPS_REPAIR, CAPS_SNAPSHOT } from "./caps.ts";
import { CANDIDATES, providerEnvFor, type Candidate } from "./candidates.ts";
import { formatReport, summarise, type SpendReport } from "./metrics.ts";
import { EVAL_PROFILES } from "./profiles.ts";
import { ratingSheet } from "./ratings.ts";
import { fixtureName, recordingFetch, type RecordedResponse } from "./record.ts";
import { runEval, type EvalRun } from "./run.ts";

/** What main() reads and writes outside itself: the command uses REAL, the tests pass fakes. */
export interface CliDeps {
  /** The environment the keys are read from. */
  env: Readonly<Record<string, string | undefined>>;
  candidates: readonly Candidate[];
  /** Builds the provider for a live request; a dry run never calls it. */
  makeProvider: typeof createProvider;
  /** The fetch that --record's recorder wraps. */
  fetch: typeof fetch;
  generateDeps: GenerateDeps;
  resultsDir: URL;
  fixturesDir: URL;
  /** Writes one line to standard output. */
  print: (line: string) => void;
  /** Writes the evaluation's progress counter as it is. */
  progress: (text: string) => void;
  /** Writes one line to standard error. */
  warn: (line: string) => void;
}

const REAL: CliDeps = {
  env: process.env,
  candidates: CANDIDATES,
  makeProvider: createProvider,
  fetch: (input, init) => fetch(input, init),
  generateDeps: REAL_DEPS,
  resultsDir: new URL("./results/", import.meta.url),
  fixturesDir: new URL("../test/fixtures/", import.meta.url),
  print: (line) => console.log(line),
  progress: (text) => void process.stdout.write(text),
  warn: (line) => console.error(line),
};

type Mode = "evaluation" | "caps probe" | "record";

interface Flags {
  mode: Mode;
  live: boolean;
  /** --max-usd in whole micro-US$, or null when it was not given. */
  maxUsdMicrousd: number | null;
  runs: number;
  /** The --only labels, or null for every candidate. */
  only: readonly string[] | null;
}

const USAGE = [
  "Usage: pnpm eval:generation [--live --max-usd <US$>] [--runs 1-10] [--only label,label] [--caps-probe | --record]",
  "A dry run unless both --live and --max-usd are given. A live run sends each site of the evaluation, or each request of --caps-probe and --record, only while the spend so far plus its worst case fits under --max-usd; the total can exceed --max-usd by at most one request's overrun above its worst case.",
].join("\n");

const readArgs = (argv: readonly string[]) =>
  parseArgs({
    args: [...argv],
    options: {
      live: { type: "boolean" },
      "max-usd": { type: "string" },
      runs: { type: "string" },
      only: { type: "string" },
      "caps-probe": { type: "boolean" },
      record: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
    tokens: true,
  });

/**
 * The flags, or why they are refused. A refusal never repeats what was typed, in case an argument holds a key. Each
 * option may be given once: a second --max-usd must never quietly replace the first (parseArgs keeps the last).
 */
export function parseFlags(argv: readonly string[], labels: readonly string[]): Flags | string {
  let parsed: ReturnType<typeof readArgs>;
  try {
    parsed = readArgs(argv);
  } catch (error) {
    return `The options could not be read (${error instanceof Error && "code" in error ? String(error.code) : "error"}). ${USAGE}`;
  }
  const { values, tokens } = parsed;
  const given = tokens.flatMap((token) => (token.kind === "option" ? [token.name] : []));
  if (new Set(given).size !== given.length) return `Give each option at most once. ${USAGE}`;
  const runs = values.runs ?? "3";
  if (!/^([1-9]|10)$/.test(runs)) return "--runs must be a whole number from 1 to 10.";
  const only = values.only?.split(",").map((label) => label.trim()) ?? null;
  if (only !== null && only.some((label) => !labels.includes(label))) return `--only takes labels from this list, separated by commas: ${labels.join(", ")}.`;
  if (values["caps-probe"] === true && values.record === true) return `Give --caps-probe or --record, not both. ${USAGE}`;
  const maxUsdMicrousd = values["max-usd"] === undefined ? null : parseMaxUsd(values["max-usd"]);
  if (values["max-usd"] !== undefined && maxUsdMicrousd === null) return "--max-usd must be an amount in US$ above 0 with at most 2 decimals, such as 5 or 2.50.";
  if (values.live === true && maxUsdMicrousd === null) return "--live needs --max-usd <US$>, the most this run may spend, such as --max-usd 5. Nothing was sent.";
  const mode = values["caps-probe"] === true ? "caps probe" : values.record === true ? "record" : "evaluation";
  return { mode, live: values.live === true, maxUsdMicrousd, runs: Number(runs), only };
}

interface Row {
  candidate: Candidate;
  /** Its provider configuration, or null when a variable it needs is missing. */
  env: ProviderEnv | null;
  /** The worst case of what the mode sends it (one site, or one request); null without a recorded price. */
  worstMicrousd: number | null;
}

/** A model a live run sends to: its key is present and its worst case is known. */
interface LiveRow {
  candidate: Candidate;
  env: ProviderEnv;
  worstMicrousd: number;
}

/** The worst case of one unit of the mode: a site of the evaluation (up to MAX_ATTEMPTS requests), or the one request of --caps-probe or --record. */
function worstCaseOf(mode: Mode, { provider, modelId }: Candidate): number | null {
  if (mode === "caps probe") return requestWorstCaseMicrousd(provider, modelId, CAPS_PROBE_OUTPUT_TOKENS);
  if (mode === "record") return requestWorstCaseMicrousd(provider, modelId, MAX_OUTPUT_TOKENS);
  return worstCaseJobMicrousd(provider, modelId);
}

const NO_KEYS = "No model keys found: nothing to run. Put ANTHROPIC_API_KEY, or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN, or GROQ_API_KEY, or HF_TOKEN in the gitignored .env at the repo root.";
const NO_PRICE = "no recorded price: cannot be run live";

/**
 * Variables the Anthropic SDK reads when a client is built (SDK 0.128.0 client.mjs:70, 80, 109, 116): another API host,
 * a bearer token, a log level that can print request bodies, and extra request headers. The adapter overrides each
 * (its own baseURL, authToken null, logLevel "off", per-request credential headers; Node only); deleting them before
 * any provider exists is the outer layer (additions A).
 */
const SDK_VARIABLES = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_LOG", "ANTHROPIC_CUSTOM_HEADERS"] as const;

/** Runs the command; returns its exit code: 0, 1 when --caps-probe could not measure every model, 2 for refused flags. */
export async function main(argv: readonly string[], deps: CliDeps = REAL): Promise<number> {
  for (const name of SDK_VARIABLES) delete process.env[name];
  const flags = parseFlags(argv, deps.candidates.map((candidate) => candidate.label));
  if (typeof flags === "string") {
    deps.warn(flags);
    return 2;
  }
  const { only } = flags;
  const rows: Row[] = deps.candidates
    .filter((candidate) => only === null || only.includes(candidate.label))
    .map((candidate) => ({ candidate, env: providerEnvFor(candidate, deps.env), worstMicrousd: worstCaseOf(flags.mode, candidate) }));
  if (!flags.live || flags.maxUsdMicrousd === null) {
    dryRun(flags, rows, deps);
    return 0;
  }
  return live(flags, flags.maxUsdMicrousd, rows, deps);
}

function dryRun(flags: Flags, rows: readonly Row[], deps: CliDeps): void {
  const sites = flags.runs * EVAL_PROFILES.length;
  const unit = flags.mode === "evaluation" ? "site" : "request";
  deps.print("Dry run: nothing is sent. A live run needs --live and --max-usd <US$>, the most it may spend.");
  if (flags.mode === "caps probe") deps.print(`Caps probe: one request per model with the largest possible prompt, at most ${MAX_INPUT_TOKENS} input and ${CAPS_PROBE_OUTPUT_TOKENS} output tokens.`);
  else if (flags.mode === "record") deps.print(`Record: one request per model for the ord-plumb profile, at most ${MAX_INPUT_TOKENS} input and ${MAX_OUTPUT_TOKENS} output tokens, saved to test/fixtures/<label>.json.`);
  else deps.print(`Evaluation: ${EVAL_PROFILES.length} profiles x ${flags.runs} ${flags.runs === 1 ? "run" : "runs"} = ${sites} sites per model; a site makes at most ${MAX_ATTEMPTS} model calls.`);
  let worstOfAll = 0;
  for (const { candidate, env, worstMicrousd } of rows) {
    let cost = NO_PRICE;
    if (worstMicrousd !== null) {
      const total = flags.mode === "evaluation" ? worstMicrousd * sites : worstMicrousd;
      if (env !== null) worstOfAll += total;
      cost = flags.mode === "evaluation" ? `worst case ${formatUsd(worstMicrousd)} per site x ${sites} sites = ${formatUsd(total)}` : `worst case ${formatUsd(worstMicrousd)} for its one request`;
    }
    deps.print(`- ${candidate.label}: key present: ${env === null ? "no" : "yes"}; ${cost}`);
  }
  if (worstOfAll > 0) deps.print(`Worst case of everything a live run would send to the models with a key: ${formatUsd(worstOfAll)}.`);
  if (flags.maxUsdMicrousd !== null) deps.print(`Budget: ${formatUsd(flags.maxUsdMicrousd)}. A live run sends each ${unit} only while the spend so far plus its worst case fits under it, cheapest model first.`);
  if (rows.every((row) => row.env === null)) deps.print(NO_KEYS);
}

async function live(flags: Flags, capMicrousd: number, rows: readonly Row[], deps: CliDeps): Promise<number> {
  if (rows.every((row) => row.env === null)) {
    deps.print(NO_KEYS);
    return 0;
  }
  const plan: LiveRow[] = [];
  let unpriced = 0;
  for (const { candidate, env, worstMicrousd } of rows) {
    if (env === null) continue;
    if (worstMicrousd !== null) plan.push({ candidate, env, worstMicrousd });
    else {
      unpriced += 1;
      deps.print(`${candidate.label}: ${NO_PRICE}`);
    }
  }
  // Cheapest worst case first, so a budget stop cuts the dearest models (a stable sort: ties keep the list's order).
  plan.sort((a, b) => a.worstMicrousd - b.worstMicrousd);
  // A request that costs more than its worst case stops the whole evaluation; --caps-probe and --record send one
  // request per model, report the overrun and go on with the other models (moderator decision, fix round #1).
  const budget = new Budget(capMicrousd, { stopAfterOverrun: flags.mode === "evaluation" });
  deps.print(`Live ${flags.mode}: budget ${formatUsd(capMicrousd)}; models, cheapest worst case first: ${plan.map((row) => row.candidate.label).join(", ") || "none"}.`);
  if (flags.mode === "evaluation") {
    await evaluate(flags.runs, plan, budget, deps);
    return 0;
  }
  if (flags.mode === "record") {
    await record(plan, budget, deps);
    printSpend(budget, deps);
    return 0;
  }
  const measured = await probeCaps(plan, budget, deps);
  printSpend(budget, deps);
  return measured && unpriced === 0 ? 0 : 1;
}

function printSpend(budget: Budget, deps: CliDeps): void {
  deps.print(`Spent: ${formatUsd(budget.spentMicrousd)} counted against the ${formatUsd(budget.capMicrousd)} budget.`);
  deps.print(describeStop(budget.stop));
}

/** The line for a --caps-probe or --record request that cost more than its worst case, if this one did. */
function printOverrun(label: string, usage: ModelResponse["usage"], budget: Budget, deps: CliDeps): void {
  const overrun = budget.overruns.find((o) => o.at === label);
  if (overrun === undefined) return;
  deps.print(`${label}: it cost ${formatUsd(overrun.countedMicrousd)}, more than its worst case of ${formatUsd(overrun.worstMicrousd)} (${usage.inputTokens} input and ${usage.outputTokens} output tokens); nothing more goes to this model, and the other models go on.`);
}

const kindOf = (error: unknown): string => (error instanceof ProviderError ? error.kind : "error");

/** What one response cost, and whether its usage was missing. */
const costOf =
  ({ provider, modelId }: Candidate) =>
  (res: ModelResponse): RequestCost => ({ actualMicrousd: costMicrousd(provider, modelId, res.usage), usageMissing: res.usageMissing === true });

/**
 * Every site through runEval under the budget, then the report (with what it spent), the results and the blind rating
 * sheet. An exception that ends the run early still leaves all of them, for the sites that completed, and is then
 * passed on (fix round #2), so what a live run spent is never lost.
 */
async function evaluate(runs: number, plan: readonly LiveRow[], budget: Budget, deps: CliDeps): Promise<void> {
  const results: EvalRun[] = [];
  let error: string | undefined;
  try {
    await runEval({
      candidates: plan.map(({ candidate, env }) => ({ label: candidate.label, provider: candidate.provider, modelId: candidate.modelId, makeProvider: (snapshot) => deps.makeProvider(env, snapshot) })),
      profiles: EVAL_PROFILES,
      runs,
      deps: deps.generateDeps,
      onRun: (done, total, run) => {
        results.push(run);
        deps.progress(`\r${done}/${total} runs`);
      },
      budget,
    });
  } catch (thrown) {
    error = kindOf(thrown);
    throw thrown;
  } finally {
    deps.progress("\n");
    writeResults(results, { budgetMicrousd: budget.capMicrousd, countedMicrousd: budget.spentMicrousd, stop: budget.stop, ...(error === undefined ? {} : { error }) }, deps);
  }
}

/** Prints the report first, so what was spent shows even if a write fails, then writes the results and the rating sheet. */
function writeResults(results: readonly EvalRun[], spend: SpendReport, deps: CliDeps): void {
  const summaries = summarise(results);
  const report = formatReport(summaries, spend);
  deps.print(report);
  const dir = new URL(`./${new Date().toISOString().replace(/[:.]/g, "-")}/`, deps.resultsDir);
  mkdirSync(dir, { recursive: true });
  const seed = Date.now() % 1_000_000;
  const { csv, key } = ratingSheet(results, seed);
  writeFileSync(new URL("runs.json", dir), JSON.stringify(results, null, 2));
  writeFileSync(new URL("summary.json", dir), JSON.stringify(summaries, null, 2));
  writeFileSync(new URL("report.md", dir), `${report}\n`);
  writeFileSync(new URL("ratings.csv", dir), csv);
  writeFileSync(new URL("ratings-key.json", dir), JSON.stringify({ seed, key }, null, 2));
  deps.print(`\nWrote ${dir.pathname}`);
}

/**
 * One request per model with the largest possible prompt, to check MAX_INPUT_TOKENS against the provider's own token
 * count. The answer is cut short on purpose; only usage matters, so an answer without usage measures nothing. One
 * model's failure is reported and the others are still probed. True when every model was measured within the bound.
 */
async function probeCaps(plan: readonly LiveRow[], budget: Budget, deps: CliDeps): Promise<boolean> {
  let measured = true;
  for (const { candidate, env, worstMicrousd } of plan) {
    let res: ModelResponse | undefined;
    try {
      // The provider is built only once the budget lets the request go.
      const request = () => deps.makeProvider(env, CAPS_SNAPSHOT).generate({ ...buildPrompt(CAPS_SNAPSHOT, CAPS_REPAIR), jsonSchema: AI_DRAFT_JSON_SCHEMA, maxOutputTokens: CAPS_PROBE_OUTPUT_TOKENS, signal: deps.generateDeps.timeoutSignal(ATTEMPT_TIMEOUT_MS) });
      res = await budget.send(candidate.label, worstMicrousd, request, costOf(candidate));
    } catch (error) {
      deps.print(`${candidate.label}: ${kindOf(error)}, not measured`);
      measured = false;
      continue;
    }
    if (res === undefined) {
      deps.print(`${candidate.label}: not measured: the budget stopped the run`);
      measured = false;
      continue;
    }
    if (res.usageMissing === true) {
      deps.print(`${candidate.label}: the answer had no usage, not measured`);
      measured = false;
    } else {
      const ok = res.usage.inputTokens <= MAX_INPUT_TOKENS;
      measured &&= ok;
      deps.print(`${candidate.label}: ${res.usage.inputTokens} input tokens for the caps prompt (bound ${MAX_INPUT_TOKENS}) ${ok ? "OK" : "OVER THE BOUND"}`);
    }
    printOverrun(candidate.label, res.usage, budget, deps);
  }
  return measured;
}

/**
 * One live answer per model for an ordinary profile, saved as test/fixtures/<label>.json so the adapters'
 * recorded-response test (test/recorded.test.ts) replays real provider output offline. The recorder keeps each
 * response's status and body only, never the request, so never the key.
 */
async function record(plan: readonly LiveRow[], budget: Budget, deps: CliDeps): Promise<void> {
  const profile = EVAL_PROFILES.find((p) => p.id === "ord-plumb")!;
  for (const { candidate, env, worstMicrousd } of plan) {
    const sink: Array<{ status: number; body: unknown }> = [];
    let res: ModelResponse | undefined;
    try {
      // The provider is built only once the budget lets the request go.
      const request = () => deps.makeProvider(env, profile.snapshot, recordingFetch(deps.fetch, sink)).generate({ ...buildPrompt(profile.snapshot), jsonSchema: AI_DRAFT_JSON_SCHEMA, maxOutputTokens: MAX_OUTPUT_TOKENS, signal: deps.generateDeps.timeoutSignal(ATTEMPT_TIMEOUT_MS) });
      res = await budget.send(candidate.label, worstMicrousd, request, costOf(candidate));
    } catch (error) {
      deps.print(`${candidate.label}: ${kindOf(error)}, nothing recorded`);
      continue;
    }
    if (res === undefined) {
      deps.print(`${candidate.label}: nothing recorded: the budget stopped the run`);
      continue;
    }
    const [response] = sink;
    if (response === undefined) deps.print(`${candidate.label}: nothing recorded: no response came back`);
    else {
      mkdirSync(deps.fixturesDir, { recursive: true });
      const recorded: RecordedResponse = { provider: candidate.provider, modelId: candidate.modelId, ...response };
      writeFileSync(new URL(fixtureName(candidate.label), deps.fixturesDir), `${JSON.stringify(recorded, null, 2)}\n`);
      deps.print(`${candidate.label}: recorded test/fixtures/${fixtureName(candidate.label)}`);
    }
    // Without usage the budget counts the larger of the partial cost and the worst case (budget.ts): the worst case,
    // unless the partial cost alone passed it, which the overrun line then reports.
    if (res.usageMissing === true && !budget.overruns.some((o) => o.at === candidate.label)) deps.print(`${candidate.label}: the answer had no usage, so it was counted at its worst case of ${formatUsd(worstMicrousd)}`);
    printOverrun(candidate.label, res.usage, budget, deps);
  }
}
