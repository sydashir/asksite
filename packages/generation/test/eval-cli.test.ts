import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { GenerationInputSnapshot } from "@asksite/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPS_PROBE_OUTPUT_TOKENS, formatUsd, requestWorstCaseMicrousd } from "../eval/budget.ts";
import { CAPS_REPAIR, CAPS_SNAPSHOT } from "../eval/caps.ts";
import { CANDIDATES, type Candidate } from "../eval/candidates.ts";
import { main, type CliDeps } from "../eval/cli.ts";
import { EVAL_PROFILES } from "../eval/profiles.ts";
import { ATTEMPT_TIMEOUT_MS, MAX_OUTPUT_TOKENS } from "../src/generate.ts";
import { worstCaseJobMicrousd } from "../src/models.ts";
import { buildPrompt } from "../src/prompt.ts";
import { ProviderError, type ModelRequest, type ModelResponse } from "../src/provider.ts";
import type { ProviderEnv } from "../src/providers/create.ts";
import { templateDraft } from "../src/template.ts";
import { AI_DRAFT_JSON_SCHEMA } from "../src/wire-schema.ts";
import { fakeFetch } from "./support/http.ts";

// Amendment P3-17: `pnpm eval:generation` is a dry run unless both --live and --max-usd are given. Every provider here
// is a fake built by a spy factory, so no test in this file can send a request; the global fetch fails loudly if
// anything reaches for it (global-constraints L).

const globalFetchCalls: unknown[] = [];
beforeEach(() => {
  globalFetchCalls.length = 0;
  vi.stubGlobal("fetch", async (...args: unknown[]) => {
    globalFetchCalls.push(args);
    throw new TypeError("the global fetch must not be used");
  });
});

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  // Clean up first: a failing check below must not leave this test's folders behind (fix round #9).
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  expect(globalFetchCalls).toEqual([]);
});

/** Stand-in keys for every candidate. They are markers: no output may ever contain one. */
const KEYS = { ANTHROPIC_API_KEY: "marker-anthropic-key", CLOUDFLARE_ACCOUNT_ID: "marker-account", CLOUDFLARE_AI_TOKEN: "marker-cf-token", GROQ_API_KEY: "marker-groq-key", HF_TOKEN: "marker-hf-token" };
const FAST = { sleep: async () => {}, timeoutSignal: () => new AbortController().signal, now: () => 0 };
const THOUSAND = { inputTokens: 1_000, outputTokens: 1_000 };
const byLabel = (label: string): Candidate => CANDIDATES.find((c) => c.label === label)!;
const OPUS = "claude-opus-5-5";
const GEMMA = "workers-ai/gemma-4-26b-a4b-it";
const GROQ = "groq/gpt-oss-120b";
const HF = "hf-router/gpt-oss-120b:groq";
const OSS = "workers-ai/gpt-oss-120b";

type Answer = (env: ProviderEnv, snapshot: GenerationInputSnapshot, fetchImpl: typeof fetch | undefined) => Promise<ModelResponse>;
/** A valid draft for the snapshot, at 1,000 tokens in and out. */
const validDraft: Answer = async (_env, snapshot) => ({ json: templateDraft(snapshot.facts, snapshot.brief), model: "fake", usage: THOUSAND, stop: "end" });

/** main()'s dependencies, all fake: providers come from a spy factory, and output, results and fixtures stay here. */
function harness(options: { env?: Record<string, string>; candidates?: readonly Candidate[]; answer?: Answer; fetch?: typeof fetch } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "asksite-eval-cli-"));
  dirs.push(dir);
  const built: string[] = [];
  const requests: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const progress: string[] = [];
  /** Each request a fake provider got, with the snapshot its provider was built for. */
  const sent: Array<{ snapshot: GenerationInputSnapshot; request: ModelRequest }> = [];
  const answer = options.answer ?? validDraft;
  const deps: CliDeps = {
    env: options.env ?? KEYS,
    candidates: options.candidates ?? CANDIDATES,
    makeProvider: (env, snapshot, fetchImpl) => {
      built.push(env.MODEL_ID);
      return {
        id: "fake",
        generate: async (request) => {
          requests.push(env.MODEL_ID);
          sent.push({ snapshot, request });
          return answer(env, snapshot, fetchImpl);
        },
      };
    },
    fetch: options.fetch ?? (async () => Promise.reject(new Error("no fetch in this test"))),
    generateDeps: FAST,
    resultsDir: pathToFileURL(join(dir, "results/")),
    fixturesDir: pathToFileURL(join(dir, "fixtures/")),
    print: (line) => void out.push(line),
    progress: (text) => void progress.push(text),
    warn: (line) => void err.push(line),
  };
  return { deps, dir, built, requests, sent, out, err, progress, text: () => [...out, ...err].join("\n") };
}

const modelIds = (labels: readonly string[]): string[] => labels.map((label) => byLabel(label).modelId);

describe("the dry run (P3-17 D1, D5 a)", () => {
  it("is the default: each candidate's worst case per site, the sites and the total, whether its key is present, and nothing built or sent", async () => {
    const h = harness();
    expect(await main([], h.deps)).toBe(0);
    expect([h.built, h.requests, h.err]).toEqual([[], [], []]);
    const opus = worstCaseJobMicrousd("anthropic", OPUS)!;
    expect(h.out).toContain(`- ${OPUS}: key present: yes; worst case ${formatUsd(opus)} per site x 60 sites = ${formatUsd(60 * opus)}`);
    for (const { label, provider, modelId } of CANDIDATES) {
      const site = worstCaseJobMicrousd(provider, modelId)!;
      expect(h.out).toContain(`- ${label}: key present: yes; worst case ${formatUsd(site)} per site x 60 sites = ${formatUsd(60 * site)}`);
    }
    expect(h.text()).not.toMatch(/marker-/);
    expect(h.text()).not.toContain("No model keys found");
    expect(readdirSync(h.dir).sort()).toEqual([]);
  });

  it("says which keys are missing, and that nothing could run live without any", async () => {
    const h = harness({ env: { GROQ_API_KEY: "marker-groq-key", CLOUDFLARE_AI_TOKEN: "marker-cf-token" } });
    expect(await main(["--runs", "1"], h.deps)).toBe(0);
    expect(h.out).toContain(`- ${GROQ}: key present: yes; worst case ${formatUsd(worstCaseJobMicrousd("openai-compatible", "openai/gpt-oss-120b")!)} per site x 20 sites = ${formatUsd(20 * worstCaseJobMicrousd("openai-compatible", "openai/gpt-oss-120b")!)}`);
    expect(h.out.filter((line) => line.includes("key present: no"))).toHaveLength(6);
    const none = harness({ env: {} });
    expect(await main(["--only", `${OPUS},${GEMMA}`], none.deps)).toBe(0);
    expect(none.out.filter((line) => line.startsWith("- "))).toHaveLength(2);
    expect(none.out.at(-1)).toMatch(/^No model keys found: nothing to run\./);
    expect([h.built, none.built, h.requests, none.requests]).toEqual([[], [], [], []]);
  });

  it("marks a candidate with no recorded price as one that cannot run live", async () => {
    const unpriced: Candidate = { label: "claude-unpriced", provider: "anthropic", modelId: "claude-unpriced", needs: ["ANTHROPIC_API_KEY"] };
    const h = harness({ candidates: [unpriced, byLabel(OPUS)] });
    expect(await main([], h.deps)).toBe(0);
    expect(h.out).toContain("- claude-unpriced: key present: yes; no recorded price: cannot be run live");
    expect(h.built).toEqual([]);
  });

  it("shows the budget when --max-usd comes without --live, and still sends nothing", async () => {
    const h = harness();
    expect(await main(["--max-usd", "5"], h.deps)).toBe(0);
    expect(h.out.some((line) => line.startsWith("Budget: $5.000000."))).toBe(true);
    expect([h.built, h.requests]).toEqual([[], []]);
  });

  it("is a dry run for --caps-probe and --record too: each request's worst case, nothing built or sent (D5 d)", async () => {
    for (const [flag, outputTokens] of [
      ["--caps-probe", CAPS_PROBE_OUTPUT_TOKENS],
      ["--record", MAX_OUTPUT_TOKENS],
    ] as const) {
      for (const argv of [[flag], [flag, "--max-usd", "5"], [flag, "--live"]]) {
        const h = harness();
        const code = await main(argv, h.deps);
        expect([h.built, h.requests]).toEqual([[], []]);
        if (argv.includes("--live")) expect(code).toBe(2);
        else expect(h.out).toContain(`- ${OPUS}: key present: yes; worst case ${formatUsd(requestWorstCaseMicrousd("anthropic", OPUS, outputTokens)!)} for its one request`);
      }
    }
  });
});

describe("refusals (P3-17 D2, D5 c)", () => {
  it("refuses --live without --max-usd: exit code 2, a clear message, nothing built or sent", async () => {
    for (const argv of [["--live"], ["--live", "--runs", "1"], ["--live", "--caps-probe"], ["--live", "--record"], ["--live", "--only", OPUS]]) {
      const h = harness();
      expect(await main(argv, h.deps)).toBe(2);
      expect(h.err).toEqual(["--live needs --max-usd <US$>, the most this run may spend, such as --max-usd 5. Nothing was sent."]);
      expect([h.built, h.requests, h.out]).toEqual([[], [], []]);
    }
  });

  it.each([
    [["--live=false"]],
    [["--live=true", "--max-usd", "5"]],
    [["--no-live"]],
    [["--live", "--max-usd"]],
    [["--live", "--max-usd", "0"]],
    [["--live", "--max-usd", "0.00"]],
    [["--live", "--max-usd", "-1"]],
    [["--live", "--max-usd=-1"]],
    [["--live", "--max-usd", "1e3"]],
    [["--live", "--max-usd", "NaN"]],
    [["--live", "--max-usd", "1.234"]],
    [["--live", "--max-usd", "99999999999999999999"]],
    [["--max-usd", "abc"]],
    [["--live", "--max-usd", "5", "--max-usd", "500"]],
    [["--live", "--live", "--max-usd", "5"]],
    [["--live", "--max-usd", "5", "extra"]],
    [["--live", "--max-usd", "5", "--", "--runs", "1"]],
    [["--runs", "0"]],
    [["--runs", "11"]],
    [["--runs", "1.5"]],
    [["--runs", "1e1"]],
    [["--runs", " 3"]],
    [["--only", "claude-opus"]],
    [["--only", `${OPUS},`]],
    [["--caps-probe", "--record"]],
    [["--unknown"]],
  ])("refuses %j with exit code 2 and builds and sends nothing", async (argv) => {
    const h = harness();
    expect(await main(argv, h.deps)).toBe(2);
    expect(h.err).toHaveLength(1);
    expect([h.built, h.requests, h.out]).toEqual([[], [], []]);
    expect(h.text()).not.toMatch(/marker-|abc|extra|unknown/);
  });

  it("states in the usage text by how much a live run's total can pass --max-usd (fix round #1)", async () => {
    const h = harness();
    expect(await main(["--help"], h.deps)).toBe(2);
    expect(h.err).toHaveLength(1);
    expect(h.err[0]).toContain("the total can exceed --max-usd by at most one request's overrun above its worst case");
  });

  it("says in the usage text never to put a key in arguments, and which key wins (fix round #13, #14)", async () => {
    const h = harness();
    expect(await main(["--help"], h.deps)).toBe(2);
    expect(h.err[0]).toContain("never put a key in arguments; keys come only from the environment");
    expect(h.err[0]).toContain("a variable set in the shell wins over the .env");
  });

  it("names the command with the long --silent, which keeps pnpm from printing the arguments back, and says never -s (#14 a)", async () => {
    const h = harness();
    expect(await main(["--help"], h.deps)).toBe(2);
    const usage = h.err[0]!;
    expect(usage).toContain("Usage: pnpm --silent eval:generation [--live --max-usd <US$>] [--runs 1-10] [--only label,label] [--caps-probe | --record]");
    expect(usage).toContain("never the short -s, which pnpm 11 (from 11.14.0) reads as --sequential in pnpm run");
    expect(usage).not.toMatch(/pnpm eval:generation|pnpm -s /);
  });

  it("documents the exit codes, in the order that decides between them (iii)", async () => {
    const h = harness();
    expect(await main(["--help"], h.deps)).toBe(2);
    expect(h.err[0]).toContain("Exit codes, the first that applies: 2 refused flags; 3 a live request cost more than its worst case, or its cost could not be counted; 1 --caps-probe could not measure every model, or an exception ended the run; 0 otherwise.");
  });
});

describe("the overrun exit code, 3, in every live mode (iii)", () => {
  /** A caps-probe answer, cut short as the probe asks, with the usage `usageOf` gives for the model. */
  const capsAnswer =
    (usageOf: (modelId: string) => ModelResponse["usage"]): Answer =>
    async (env) => ({ json: undefined, model: "fake", usage: usageOf(env.MODEL_ID), stop: "max_tokens" });

  it("--caps-probe: exits 3 after an overrun from input tokens over the bound", async () => {
    const h = harness({ answer: capsAnswer(() => ({ inputTokens: 70_010, outputTokens: 256 })) });
    expect(await main(["--caps-probe", "--live", "--max-usd", "1", "--only", GEMMA], h.deps)).toBe(3);
    expect(h.out).toContain(`${GEMMA}: 70010 input tokens for the caps prompt (bound 70000) OVER THE BOUND`);
    expect(h.out).toContain(`${GEMMA}: it cost $0.007078, more than its worst case of $0.007077 (70010 input and 256 output tokens); nothing more goes to this model, and the other models go on.`);
  });

  it("--caps-probe: exits 3 after an overrun from output tokens alone, the input within the bound", async () => {
    // 51,234 x 0.1 + 10,000 x 0.3 = 8,123.4, so 8,124 against gemma's caps worst case of 7,077.
    const h = harness({ answer: capsAnswer(() => ({ inputTokens: 51_234, outputTokens: 10_000 })) });
    expect(await main(["--caps-probe", "--live", "--max-usd", "1", "--only", GEMMA], h.deps)).toBe(3);
    expect(h.out).toContain(`${GEMMA}: 51234 input tokens for the caps prompt (bound 70000) OK`);
    expect(h.out).toContain(`${GEMMA}: it cost $0.008124, more than its worst case of $0.007077 (51234 input and 10000 output tokens); nothing more goes to this model, and the other models go on.`);
  });

  it("--caps-probe: exits 0 without an overrun", async () => {
    const h = harness({ answer: capsAnswer(() => ({ inputTokens: 51_234, outputTokens: 256 })) });
    expect(await main(["--caps-probe", "--live", "--max-usd", "1", "--only", `${GEMMA},${GROQ}`], h.deps)).toBe(0);
    expect(h.out.filter((line) => line.endsWith("(bound 70000) OK"))).toHaveLength(2);
    expect(h.out.join("\n")).not.toContain("more than its worst case");
  });

  it("--caps-probe: exits 3, not 1, when one model overruns and another could not be measured (money first)", async () => {
    // groq: 51,234 x 0.15 + 10,000 x 0.6 = 13,685.1, so 13,686 against its caps worst case of 10,654.
    const h = harness({
      answer: async (env) => {
        if (env.MODEL_ID === byLabel(GEMMA).modelId) throw new ProviderError("unavailable", "down");
        return capsAnswer(() => ({ inputTokens: 51_234, outputTokens: 10_000 }))(env, CAPS_SNAPSHOT, undefined);
      },
    });
    expect(await main(["--caps-probe", "--live", "--max-usd", "1", "--only", `${GEMMA},${GROQ}`], h.deps)).toBe(3);
    expect(h.out).toContain(`${GEMMA}: unavailable, not measured`);
    expect(h.out).toContain(`${GROQ}: it cost $0.013686, more than its worst case of $0.010654 (51234 input and 10000 output tokens); nothing more goes to this model, and the other models go on.`);
  });

  it("exits 3 when an exception ends a run after an overrun (money first), and names the error's kind only", async () => {
    const h = harness({ answer: capsAnswer((modelId) => ({ inputTokens: modelId === byLabel(GEMMA).modelId ? 70_010 : 51_234, outputTokens: 256 })) });
    const print = h.deps.print;
    h.deps.print = (line) => {
      if (line.startsWith(`${GROQ}: 51234 input tokens`)) throw new Error("marker-print-failed");
      print(line);
    };
    expect(await main(["--caps-probe", "--live", "--max-usd", "1", "--only", `${GEMMA},${GROQ}`], h.deps)).toBe(3);
    expect(h.requests).toEqual(modelIds([GEMMA, GROQ]));
    expect(h.err).toEqual(["The run ended early on an error (error) after a request that cost more than its worst case or whose cost could not be counted."]);
    expect(h.text()).not.toContain("marker-print-failed");
    // gemma 7,078 (its overrun) and groq 51,234 x 0.15 + 256 x 0.6 = 7,838.7, so 7,839.
    expect(h.out.slice(-2)).toEqual(["Spent: $0.014917 counted against the $1.000000 budget.", "The budget did not stop the run."]);
  });
});

describe("a live caps probe (P3-17 D3)", () => {
  const measured: Answer = async () => ({ json: undefined, model: "fake", usage: { inputTokens: 51_234, outputTokens: 256 }, stop: "max_tokens" });

  it("sends one request per model, cheapest worst case first, and stops before the first that does not fit", async () => {
    const h = harness({ answer: measured });
    // Caps worst cases: gemma $0.007077, groq $0.010654, hf $0.010692, workers-ai gpt-oss $0.024692, ... Actual costs of
    // 51,234 in and 256 out: gemma 5,201, groq 7,839, hf 7,878 micro-US$ (20,918 in all); gpt-oss would then pass $0.03.
    expect(await main(["--caps-probe", "--live", "--max-usd", "0.03"], h.deps)).toBe(1);
    expect(h.requests).toEqual(modelIds([GEMMA, GROQ, "hf-router/gpt-oss-120b:groq"]));
    expect(h.built).toEqual(h.requests);
    expect(h.out).toContain(`${GEMMA}: 51234 input tokens for the caps prompt (bound 70000) OK`);
    expect(h.out).toContain("workers-ai/gpt-oss-120b: not measured: the budget stopped the run");
    expect(h.out).toContain(`${OPUS}: not measured: the budget stopped the run`);
    expect(h.out).toContain("Spent: $0.020918 counted against the $0.030000 budget.");
    expect(h.out).toContain("Stopped for the budget before workers-ai/gpt-oss-120b: its worst case would have taken the spend over the budget, so nothing more was sent.");
    expect(h.text()).not.toMatch(/marker-/);
  });

  it("orders every model by its worst case, whatever the order of the list or of --only", async () => {
    const h = harness({ answer: measured });
    const all = CANDIDATES.map((c) => c.label).reverse().join(",");
    expect(await main(["--caps-probe", "--live", "--max-usd", "10", "--only", all], h.deps)).toBe(0);
    expect(h.requests).toEqual(modelIds([GEMMA, GROQ, "hf-router/gpt-oss-120b:groq", "workers-ai/gpt-oss-120b", "workers-ai/qwen3.8-27b", "claude-sonnet-5", OPUS]));
    expect(h.out).toContain("The budget did not stop the run.");
  });

  it("reports a provider error or a missing usage as not measured, counts it at its worst case, and still probes the others", async () => {
    const h = harness({
      candidates: [byLabel(GEMMA), byLabel(GROQ), byLabel(OPUS)],
      answer: async (env) => {
        if (env.MODEL_ID === byLabel(GEMMA).modelId) throw new ProviderError("unavailable", "down");
        if (env.MODEL_ID === byLabel(GROQ).modelId) return { json: undefined, model: "fake", usage: { inputTokens: 0, outputTokens: 0 }, stop: "max_tokens", usageMissing: true };
        return { json: undefined, model: "fake", usage: { inputTokens: 70_001, outputTokens: 256 }, stop: "max_tokens" };
      },
    });
    expect(await main(["--caps-probe", "--live", "--max-usd", "1"], h.deps)).toBe(3);
    expect(h.out).toContain(`${GEMMA}: unavailable, not measured`);
    expect(h.out).toContain(`${GROQ}: the answer had no usage, not measured`);
    expect(h.out).toContain(`${OPUS}: 70001 input tokens for the caps prompt (bound 70000) OVER THE BOUND`);
    const worst = (label: string) => requestWorstCaseMicrousd(byLabel(label).provider, byLabel(label).modelId, CAPS_PROBE_OUTPUT_TOKENS)!;
    const opusCost = Math.ceil(70_001 * 4 + 256 * 20);
    expect(h.out).toContain(`Spent: ${formatUsd(worst(GEMMA) + worst(GROQ) + opusCost)} counted against the $1.000000 budget.`);
    expect(h.out).toContain(`${OPUS}: it cost ${formatUsd(opusCost)}, more than its worst case of ${formatUsd(worst(OPUS))} (70001 input and 256 output tokens); nothing more goes to this model, and the other models go on.`);
    expect(h.out).toContain("The budget did not stop the run.");
  });

  it("reports a model that cost more than its worst case, with its tokens, and still probes the others (fix round #1)", async () => {
    const h = harness({
      candidates: [byLabel(GEMMA), byLabel(GROQ), byLabel(OPUS)],
      answer: async (env) => ({ json: undefined, model: "fake", usage: { inputTokens: env.MODEL_ID === byLabel(GEMMA).modelId ? 70_010 : 51_234, outputTokens: 256 }, stop: "max_tokens" }),
    });
    expect(await main(["--caps-probe", "--live", "--max-usd", "5"], h.deps)).toBe(3);
    expect(h.requests).toEqual(modelIds([GEMMA, GROQ, OPUS]));
    // gemma: 70,010 x 0.1 + 256 x 0.3 = 7,077.8, so 7,078 against its worst case of 7,077 (70,000 input tokens).
    expect(h.out).toContain(`${GEMMA}: 70010 input tokens for the caps prompt (bound 70000) OVER THE BOUND`);
    expect(h.out).toContain(`${GEMMA}: it cost $0.007078, more than its worst case of $0.007077 (70010 input and 256 output tokens); nothing more goes to this model, and the other models go on.`);
    expect(h.out).toContain(`${GROQ}: 51234 input tokens for the caps prompt (bound 70000) OK`);
    expect(h.out).toContain(`${OPUS}: 51234 input tokens for the caps prompt (bound 70000) OK`);
    // groq 7,839 and opus 51,234 x 4 + 256 x 20 = 210,056.
    expect(h.out).toContain(`Spent: ${formatUsd(7_078 + 7_839 + 210_056)} counted against the $5.000000 budget.`);
    expect(h.out).toContain("The budget did not stop the run.");
  });

  it("passes the cap by at most that one overrun: the next model's check counts it (fix round #1)", async () => {
    const h = harness({
      candidates: [byLabel(OSS), byLabel(HF), byLabel(GROQ), byLabel(GEMMA)],
      answer: async (env) => ({ json: undefined, model: "fake", usage: { inputTokens: env.MODEL_ID === byLabel(HF).modelId ? 120_000 : 51_234, outputTokens: 256 }, stop: "max_tokens" }),
    });
    expect(await main(["--caps-probe", "--live", "--max-usd", "0.03"], h.deps)).toBe(3);
    // gemma 5,201 + groq 7,839 = 13,040, and hf's worst case of 10,692 still fits under 30,000. hf then costs
    // 120,000 x 0.15 + 256 x 0.75 = 18,192, an overrun of 7,500: the spend of 31,232 passes the cap by 1,232, less than
    // that overrun, and workers-ai gpt-oss (worst case 24,692) is refused.
    expect(h.requests).toEqual(modelIds([GEMMA, GROQ, HF]));
    expect(h.out).toContain(`${HF}: it cost $0.018192, more than its worst case of $0.010692 (120000 input and 256 output tokens); nothing more goes to this model, and the other models go on.`);
    expect(h.out).toContain(`${OSS}: not measured: the budget stopped the run`);
    expect(h.out).toContain("Spent: $0.031232 counted against the $0.030000 budget.");
    expect(31_232).toBeLessThanOrEqual(30_000 + (18_192 - 10_692));
    expect(h.out).toContain(`Stopped for the budget before ${OSS}: its worst case would have taken the spend over the budget, so nothing more was sent.`);
  });

  it("refuses a candidate with no recorded price and probes the others (P3-17 D3, D5 f)", async () => {
    const unpriced: Candidate = { label: "claude-unpriced", provider: "anthropic", modelId: "claude-unpriced", needs: ["ANTHROPIC_API_KEY"] };
    const h = harness({ candidates: [unpriced, byLabel(GEMMA)], answer: measured });
    expect(await main(["--caps-probe", "--live", "--max-usd", "5"], h.deps)).toBe(1);
    expect(h.out).toContain("claude-unpriced: no recorded price: cannot be run live");
    expect([h.built, h.requests]).toEqual([[byLabel(GEMMA).modelId], [byLabel(GEMMA).modelId]]);
  });

  it("prints the no-key message and sends nothing when no chosen model has its key", async () => {
    const h = harness({ env: { GROQ_API_KEY: "marker-groq-key" } });
    expect(await main(["--caps-probe", "--live", "--max-usd", "5", "--only", OPUS], h.deps)).toBe(0);
    expect(h.out).toEqual(["No model keys found: nothing to run. Put ANTHROPIC_API_KEY, or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN, or GROQ_API_KEY, or HF_TOKEN in the gitignored .env at the repo root."]);
    expect(h.built).toEqual([]);
  });
});

describe("a live evaluation (P3-17 D3, D4)", () => {
  it("runs the cheapest model first and sends a site only while its worst case still fits, then writes the report with the spend", async () => {
    const h = harness();
    // gemma's 20 sites cost 400 micro-US$ each; opus's sites 24,000 each against a worst case of 1,331,520. With $1.37,
    // opus's third site would pass the budget at worst: 8,000 + 2 x 24,000 + 1,331,520 = 1,387,520.
    expect(await main(["--live", "--max-usd", "1.37", "--runs", "1", "--only", `${OPUS},${GEMMA}`], h.deps)).toBe(0);
    expect(h.requests).toEqual([...Array.from({ length: 20 }, () => byLabel(GEMMA).modelId), byLabel(OPUS).modelId, byLabel(OPUS).modelId]);
    expect(h.progress.at(-2)).toBe("\r22/40 runs");
    const [stamp] = readdirSync(join(h.dir, "results"));
    const files = readdirSync(join(h.dir, "results", stamp!)).sort();
    expect(files).toEqual(["ratings-key.json", "ratings.csv", "report.md", "runs.json", "summary.json"]);
    const report = readFileSync(join(h.dir, "results", stamp!, "report.md"), "utf8");
    expect(report).toContain("- Budget: $1.370000. Counted against it: $0.056000 (a site with an attempt without usage counts at its worst case).");
    expect(report).toContain(`- Stopped for the budget before ${OPUS} ${EVAL_PROFILES[2]!.id} run 1: its worst case would have taken the spend over the budget, so nothing more was sent.`);
    expect(h.out.join("\n")).toContain(report.trimEnd());
    expect(h.text()).not.toMatch(/marker-/);
  });

  it("gives no gate verdict for a model the budget cut short (fix round #10)", async () => {
    const h = harness();
    // As above: gemma runs its 20 sites, opus only 2 of its 20.
    expect(await main(["--live", "--max-usd", "1.37", "--runs", "1", "--only", `${OPUS},${GEMMA}`], h.deps)).toBe(0);
    const [stamp] = readdirSync(join(h.dir, "results"));
    const report = readFileSync(join(h.dir, "results", stamp!, "report.md"), "utf8");
    expect(report).toContain(`| ${GEMMA} | 20 | 100% | 100% | 0 | 0 | $0.0004 | pass |`);
    expect(report).toContain(`| ${OPUS} | 2 | 100% | 100% | 0 | 0 | $0.0240 | not enough runs: cut by the budget |`);
    const summary = JSON.parse(readFileSync(join(h.dir, "results", stamp!, "summary.json"), "utf8")) as Array<{ label: string; meetsAutomaticGate: boolean | null }>;
    expect(summary.map((s) => [s.label, s.meetsAutomaticGate])).toEqual([
      [GEMMA, true],
      [OPUS, null],
    ]);
  });

  it("lists a planned model the budget cut before its first site as not run (budget); summary.json lists only models that ran (i)", async () => {
    const h = harness();
    // gemma's 20 sites cost 400 each; then opus's first site, at its worst case of 1,331,520, does not fit under $1.
    expect(await main(["--live", "--max-usd", "1", "--runs", "1", "--only", `${OPUS},${GEMMA}`], h.deps)).toBe(0);
    expect(h.requests).toEqual(Array.from({ length: 20 }, () => byLabel(GEMMA).modelId));
    const [stamp] = readdirSync(join(h.dir, "results"));
    const report = readFileSync(join(h.dir, "results", stamp!, "report.md"), "utf8");
    expect(report).toContain(`| ${GEMMA} | 20 | 100% | 100% | 0 | 0 | $0.0004 | pass |\n| ${OPUS} | 0 | n/a | n/a | n/a | n/a | n/a | not run (budget) |\n`);
    const summary = JSON.parse(readFileSync(join(h.dir, "results", stamp!, "summary.json"), "utf8")) as Array<{ label: string }>;
    expect(summary.map((s) => s.label)).toEqual([GEMMA]);
  });

  it("lists a planned model an error cut before its first site as not run (error) (i)", async () => {
    const h = harness();
    const build = h.deps.makeProvider;
    h.deps.makeProvider = (env, snapshot, fetchImpl) => {
      if (env.MODEL_ID === byLabel(GROQ).modelId) throw new ProviderError("auth", "OPENAI_COMPAT_API_KEY is blank");
      return build(env, snapshot, fetchImpl);
    };
    await expect(main(["--live", "--max-usd", "5", "--runs", "1", "--only", `${GEMMA},${GROQ},${OPUS}`], h.deps)).rejects.toThrow(ProviderError);
    const [stamp] = readdirSync(join(h.dir, "results"));
    const report = readFileSync(join(h.dir, "results", stamp!, "report.md"), "utf8");
    expect(report).toContain(`| ${GEMMA} | 20 | 100% | 100% | 0 | 0 | $0.0004 | pass |\n| ${GROQ} | 0 | n/a | n/a | n/a | n/a | n/a | not run (error) |\n| ${OPUS} | 0 | n/a | n/a | n/a | n/a | n/a | not run (error) |\n`);
    const summary = JSON.parse(readFileSync(join(h.dir, "results", stamp!, "summary.json"), "utf8")) as Array<{ label: string }>;
    expect(summary.map((s) => s.label)).toEqual([GEMMA]);
  });

  it("refuses a candidate with no recorded price and evaluates the others", async () => {
    const unpriced: Candidate = { label: "claude-unpriced", provider: "anthropic", modelId: "claude-unpriced", needs: ["ANTHROPIC_API_KEY"] };
    const h = harness({ candidates: [unpriced, byLabel(GEMMA)] });
    expect(await main(["--live", "--max-usd", "1", "--runs", "1"], h.deps)).toBe(0);
    expect(h.out).toContain("claude-unpriced: no recorded price: cannot be run live");
    expect(new Set(h.built)).toEqual(new Set([byLabel(GEMMA).modelId]));
    expect(h.requests).toHaveLength(20);
  });

  it("reports what the budget counted, which differs from the actual spend when usage is missing (fix round #8)", async () => {
    const h = harness({ answer: async (env, snapshot, fetchImpl) => ({ ...(await validDraft(env, snapshot, fetchImpl)), usageMissing: true }) });
    expect(await main(["--live", "--max-usd", "1", "--runs", "1", "--only", GEMMA], h.deps)).toBe(0);
    expect(h.requests).toHaveLength(20);
    const [stamp] = readdirSync(join(h.dir, "results"));
    const report = readFileSync(join(h.dir, "results", stamp!, "report.md"), "utf8");
    // Each of the 20 sites lacks usage, so each counts at gemma's site worst case of 28,373; their actual cost is 400 each.
    expect(report).toContain("- Budget: $1.000000. Counted against it: $0.567460 (a site with an attempt without usage counts at its worst case).");
    expect(report).toContain(`- ${GEMMA}: spent $0.008000, plus unknown (20 attempts without usage)\n`);
  });

  it("still stops everything after a site that cost more than its worst case (fix round #1)", async () => {
    // gemma's site worst case is 3 x (70,000 x 0.1 + 8,192 x 0.3) = 28,373; this site costs 300,000 x 0.1 + 1,000 x 0.3 = 30,300.
    const h = harness({ answer: async (env, snapshot, fetchImpl) => ({ ...(await validDraft(env, snapshot, fetchImpl)), usage: { inputTokens: 300_000, outputTokens: 1_000 } }) });
    expect(await main(["--live", "--max-usd", "5", "--runs", "1", "--only", `${GEMMA},${GROQ}`], h.deps)).toBe(3);
    expect(h.requests).toEqual(modelIds([GEMMA]));
    const [stamp] = readdirSync(join(h.dir, "results"));
    const report = readFileSync(join(h.dir, "results", stamp!, "report.md"), "utf8");
    expect(report).toContain("- Budget: $5.000000. Counted against it: $0.030300 (a site with an attempt without usage counts at its worst case).");
    expect(report).toContain(`- Stopped after ${GEMMA} ${EVAL_PROFILES[0]!.id} run 1: it cost more than its worst case, so the budget can no longer bound the run; nothing more was sent.`);
  });

  it("keeps what completed when an error ends the run: the results, the report with the spend, then the error (fix round #2)", async () => {
    // generateDraft turns a provider's own errors into attempt outcomes; an exception from our code (here the provider
    // factory, on the fourth site) propagates.
    const boom = new Error("boom");
    const h = harness();
    const build = h.deps.makeProvider;
    h.deps.makeProvider = (env, snapshot, fetchImpl) => {
      if (h.built.length === 3) throw boom;
      return build(env, snapshot, fetchImpl);
    };
    await expect(main(["--live", "--max-usd", "5", "--runs", "1", "--only", `${GEMMA},${GROQ}`], h.deps)).rejects.toBe(boom);
    expect(h.requests).toEqual(modelIds([GEMMA, GEMMA, GEMMA]));
    expect(h.progress.slice(-2)).toEqual(["\r3/40 runs", "\n"]);
    const [stamp] = readdirSync(join(h.dir, "results"));
    const dir = join(h.dir, "results", stamp!);
    expect(readdirSync(dir).sort()).toEqual(["ratings-key.json", "ratings.csv", "report.md", "runs.json", "summary.json"]);
    expect(JSON.parse(readFileSync(join(dir, "runs.json"), "utf8"))).toHaveLength(3);
    const report = readFileSync(join(dir, "report.md"), "utf8");
    // Three sites at 400 micro-US$ each, and the site that threw at gemma's site worst case of 28,373.
    expect(report).toContain("- Budget: $5.000000. Counted against it: $0.029573 (a site with an attempt without usage counts at its worst case).");
    expect(report).toContain(`- ${GEMMA}: spent $0.001200\n`);
    expect(report).toContain("- The run ended early on an error (error): the results are the sites that completed before it.");
    expect(report).toContain(`| ${GEMMA} | 3 | 100% | 100% | 0 | 0 | $0.0004 | not enough runs: cut by an error |`);
    expect(h.out.join("\n")).toContain(report.trimEnd());
  });

  it("keeps what completed when a provider cannot be built mid-run (fix round #2)", async () => {
    const h = harness();
    const build = h.deps.makeProvider;
    h.deps.makeProvider = (env, snapshot, fetchImpl) => {
      if (env.MODEL_ID === byLabel(GROQ).modelId) throw new ProviderError("auth", "OPENAI_COMPAT_API_KEY is blank");
      return build(env, snapshot, fetchImpl);
    };
    await expect(main(["--live", "--max-usd", "5", "--runs", "1", "--only", `${GEMMA},${GROQ}`], h.deps)).rejects.toThrow(ProviderError);
    expect(h.requests).toHaveLength(20);
    const [stamp] = readdirSync(join(h.dir, "results"));
    expect(JSON.parse(readFileSync(join(h.dir, "results", stamp!, "runs.json"), "utf8"))).toHaveLength(20);
    const report = readFileSync(join(h.dir, "results", stamp!, "report.md"), "utf8");
    // gemma's 20 sites at 400 each, and groq's first site at its worst case of 46,246 (the build threw inside the gate).
    expect(report).toContain("- Budget: $5.000000. Counted against it: $0.054246 (a site with an attempt without usage counts at its worst case).");
    expect(report).toContain("- The run ended early on an error (auth): the results are the sites that completed before it.");
  });

  it("fails closed on a site whose cost cannot be counted: its worst case, then nothing more (fix round #4)", async () => {
    const h = harness({ answer: async (env, snapshot, fetchImpl) => ({ ...(await validDraft(env, snapshot, fetchImpl)), usage: { inputTokens: Number.NaN, outputTokens: 1_000 } }) });
    expect(await main(["--live", "--max-usd", "5", "--runs", "1", "--only", `${GEMMA},${GROQ}`], h.deps)).toBe(3);
    expect(h.requests).toEqual(modelIds([GEMMA]));
    const [stamp] = readdirSync(join(h.dir, "results"));
    const report = readFileSync(join(h.dir, "results", stamp!, "report.md"), "utf8");
    expect(report).toContain(`- Budget: $5.000000. Counted against it: ${formatUsd(worstCaseJobMicrousd("openai-compatible", byLabel(GEMMA).modelId)!)} (a site with an attempt without usage counts at its worst case).`);
    expect(report).toContain(`- Stopped after ${GEMMA} ${EVAL_PROFILES[0]!.id} run 1: its cost was not a whole number of micro-US$ of at least 0, so it was counted at its worst case; nothing more was sent.`);
  });
});

describe("a cost or usage that cannot be counted (B)", () => {
  // Token counts that are not whole numbers from 0 to Number.MAX_SAFE_INTEGER. The shipped adapters never pass one on
  // (they clamp); a future adapter or a stand-in could.
  const UNCOUNTABLE = [
    ["NaN", Number.NaN],
    ["-1", -1],
    ["-1,000,000", -1_000_000],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["0.5", 0.5],
    ["2 ** 53", 2 ** 53],
  ] as const;
  /** A raw number standing where a cost or a count should be. */
  const RAW = /NaN|Infinity|\$-|-\d+ (input )?tokens|9007199254740992/;

  it.each(UNCOUNTABLE)("the evaluation, input tokens %s: the site counts at its worst case, stops the run, shows no raw number anywhere and exits 3", async (_name, inputTokens) => {
    const h = harness({ answer: async (env, snapshot, fetchImpl) => ({ ...(await validDraft(env, snapshot, fetchImpl)), usage: { inputTokens, outputTokens: 1_000 } }) });
    expect(await main(["--live", "--max-usd", "5", "--runs", "1", "--only", `${GEMMA},${GROQ}`], h.deps)).toBe(3);
    expect(h.requests).toEqual(modelIds([GEMMA]));
    const [stamp] = readdirSync(join(h.dir, "results"));
    const report = readFileSync(join(h.dir, "results", stamp!, "report.md"), "utf8");
    // gemma's site worst case: 3 x (70,000 x 0.1 + 8,192 x 0.3) = 28,372.8, so 28,373.
    const phrase = "not countable (counted at its worst case $0.028373)";
    expect(report).toContain(`| ${GEMMA} | 1 | 100% | 100% | 0 | 0 | ${phrase} | not enough runs: cut by the budget |`);
    expect(report).toContain(`- Largest input per run: ${phrase}\n`);
    expect(report).toContain(`- ${GEMMA}: spent ${phrase}\n`);
    expect(report).toContain(`- In total: spent ${phrase}\n`);
    expect(report).toContain("- Budget: $5.000000. Counted against it: $0.028373 (a site with an attempt without usage counts at its worst case).");
    expect(report).toContain(`- Stopped after ${GEMMA} ${EVAL_PROFILES[0]!.id} run 1: its cost was not a whole number of micro-US$ of at least 0, so it was counted at its worst case; nothing more was sent.`);
    expect(report).not.toMatch(RAW);
    expect(h.text()).not.toMatch(RAW);
  });

  it("the evaluation, output tokens NaN: the costs are not countable, the input count still shows", async () => {
    const h = harness({ answer: async (env, snapshot, fetchImpl) => ({ ...(await validDraft(env, snapshot, fetchImpl)), usage: { inputTokens: 1_000, outputTokens: Number.NaN } }) });
    expect(await main(["--live", "--max-usd", "5", "--runs", "1", "--only", GEMMA], h.deps)).toBe(3);
    const [stamp] = readdirSync(join(h.dir, "results"));
    const report = readFileSync(join(h.dir, "results", stamp!, "report.md"), "utf8");
    expect(report).toContain(`- ${GEMMA}: spent not countable (counted at its worst case $0.028373)\n`);
    expect(report).toContain("- Largest input per run: 1000 tokens\n");
    expect(report).not.toMatch(RAW);
  });

  it.each(UNCOUNTABLE)("--caps-probe, input tokens %s: never OK, no raw number, the request counted at its worst case, exit 3", async (_name, inputTokens) => {
    const h = harness({ answer: async () => ({ json: undefined, model: "fake", usage: { inputTokens, outputTokens: 256 }, stop: "max_tokens" }) });
    expect(await main(["--caps-probe", "--live", "--max-usd", "1", "--only", `${GEMMA},${GROQ}`], h.deps)).toBe(3);
    expect(h.requests).toEqual(modelIds([GEMMA]));
    expect(h.out).toContain(`${GEMMA}: input tokens for the caps prompt not countable (counted at its worst case $0.007077), not measured`);
    expect(h.out).toContain(`${GROQ}: not measured: the budget stopped the run`);
    expect(h.out).toContain("Spent: $0.007077 counted against the $1.000000 budget.");
    expect(h.out.filter((line) => line.endsWith("OK"))).toEqual([]);
    expect(h.text()).not.toMatch(RAW);
  });

  it.each(UNCOUNTABLE)("--record, input tokens %s: says the cost was not countable and what was counted, no raw number, exit 3", async (_name, inputTokens) => {
    const body = { model: "m", choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 6 } };
    const http = fakeFetch([{ status: 200, body }]);
    const recorded: Answer = async (env, snapshot, fetchImpl) => {
      await fetchImpl!("https://record.example.invalid/v1/chat/completions", { method: "POST", body: "{}" });
      return { ...(await validDraft(env, snapshot, fetchImpl)), usage: { inputTokens, outputTokens: 1_000 } };
    };
    const h = harness({ answer: recorded, fetch: http.fetch });
    expect(await main(["--record", "--live", "--max-usd", "1", "--only", `${GEMMA},${GROQ}`], h.deps)).toBe(3);
    expect(h.requests).toEqual(modelIds([GEMMA]));
    expect(h.out).toContain(`${GEMMA}: recorded test/fixtures/workers-ai__gemma-4-26b-a4b-it.json`);
    // gemma's --record worst case: 70,000 x 0.1 + 8,192 x 0.3 = 9,457.6, so 9,458.
    expect(h.out).toContain(`${GEMMA}: its cost was not countable (counted at its worst case $0.009458)`);
    expect(h.out).toContain("Spent: $0.009458 counted against the $1.000000 budget.");
    expect(h.text()).not.toMatch(RAW);
  });
});

describe("a live --record (P3-17 D3)", () => {
  it("records one response per model, cheapest first, and stops before a request that does not fit", async () => {
    const body = { model: "m", choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 6 } };
    const http = fakeFetch([
      { status: 200, body },
      { status: 200, body },
    ]);
    const recorded: Answer = async (_env, snapshot, fetchImpl) => {
      await fetchImpl!("https://record.example.invalid/v1/chat/completions", { method: "POST", body: "{}" });
      return validDraft(_env, snapshot, fetchImpl);
    };
    const h = harness({ answer: recorded, fetch: http.fetch });
    // --record worst cases: gemma $0.009458, groq $0.015416, opus $0.443840; the actual 400 + 750 leave opus far over $0.03.
    expect(await main(["--record", "--live", "--max-usd", "0.03", "--only", `${OPUS},${GROQ},${GEMMA}`], h.deps)).toBe(0);
    expect(h.requests).toEqual(modelIds([GEMMA, GROQ]));
    expect(h.built).toEqual(h.requests);
    expect(readdirSync(join(h.dir, "fixtures")).sort()).toEqual(["groq__gpt-oss-120b.json", "workers-ai__gemma-4-26b-a4b-it.json"]);
    const fixture = readFileSync(join(h.dir, "fixtures", "groq__gpt-oss-120b.json"), "utf8");
    expect(JSON.parse(fixture)).toEqual({ provider: "openai-compatible", modelId: "openai/gpt-oss-120b", status: 200, body });
    expect(fixture).not.toMatch(/marker-/);
    expect(h.out).toContain("groq/gpt-oss-120b: recorded test/fixtures/groq__gpt-oss-120b.json");
    expect(h.out).toContain(`${OPUS}: nothing recorded: the budget stopped the run`);
    expect(h.out).toContain("Spent: $0.001150 counted against the $0.030000 budget.");
  });

  it("reports a model that cost more than its worst case and still records the others (fix round #1)", async () => {
    const body = { model: "m", choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 6 } };
    const http = fakeFetch([
      { status: 200, body },
      { status: 200, body },
    ]);
    // gemma's --record worst case is 70,000 x 0.1 + 8,192 x 0.3 = 9,457.6, so 9,458; 70,010 input tokens make 9,459.
    const recorded: Answer = async (env, snapshot, fetchImpl) => {
      await fetchImpl!("https://record.example.invalid/v1/chat/completions", { method: "POST", body: "{}" });
      const usage = env.MODEL_ID === byLabel(GEMMA).modelId ? { inputTokens: 70_010, outputTokens: 8_192 } : THOUSAND;
      return { ...(await validDraft(env, snapshot, fetchImpl)), usage };
    };
    const h = harness({ answer: recorded, fetch: http.fetch });
    expect(await main(["--record", "--live", "--max-usd", "1", "--only", `${GROQ},${GEMMA}`], h.deps)).toBe(3);
    expect(h.requests).toEqual(modelIds([GEMMA, GROQ]));
    expect(readdirSync(join(h.dir, "fixtures")).sort()).toEqual(["groq__gpt-oss-120b.json", "workers-ai__gemma-4-26b-a4b-it.json"]);
    expect(h.out).toContain(`${GEMMA}: it cost $0.009459, more than its worst case of $0.009458 (70010 input and 8192 output tokens); nothing more goes to this model, and the other models go on.`);
    expect(h.out).toContain("groq/gpt-oss-120b: recorded test/fixtures/groq__gpt-oss-120b.json");
    expect(h.out).toContain("The budget did not stop the run.");
  });
});

describe("the spend line when our own code throws outside the per-model try (ii)", () => {
  it("--caps-probe: prints what was spent, then passes the exception on", async () => {
    const boom = new Error("boom");
    const h = harness({ answer: async () => ({ json: undefined, model: "fake", usage: { inputTokens: 51_234, outputTokens: 256 }, stop: "max_tokens" }) });
    const print = h.deps.print;
    h.deps.print = (line) => {
      if (line.startsWith(`${GEMMA}: 51234 input tokens`)) throw boom;
      print(line);
    };
    await expect(main(["--caps-probe", "--live", "--max-usd", "1", "--only", `${GEMMA},${GROQ}`], h.deps)).rejects.toBe(boom);
    expect(h.requests).toEqual(modelIds([GEMMA]));
    // gemma's answer: 51,234 x 0.1 + 256 x 0.3 = 5,200.2, so 5,201.
    expect(h.out.slice(-2)).toEqual(["Spent: $0.005201 counted against the $1.000000 budget.", "The budget did not stop the run."]);
  });

  it("--record: prints what was spent after a fixture that cannot be written, then passes the exception on", async () => {
    const body = { model: "m", choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 6 } };
    const http = fakeFetch([{ status: 200, body }]);
    const recorded: Answer = async (env, snapshot, fetchImpl) => {
      await fetchImpl!("https://record.example.invalid/v1/chat/completions", { method: "POST", body: "{}" });
      return validDraft(env, snapshot, fetchImpl);
    };
    const h = harness({ answer: recorded, fetch: http.fetch });
    // The fixtures folder would sit under a plain file, so it cannot be made (ENOTDIR).
    writeFileSync(join(h.dir, "blocker"), "");
    h.deps.fixturesDir = pathToFileURL(join(h.dir, "blocker", "fixtures/"));
    await expect(main(["--record", "--live", "--max-usd", "1", "--only", `${GEMMA},${GROQ}`], h.deps)).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(h.requests).toEqual(modelIds([GEMMA]));
    // gemma's answer: 1,000 x 0.1 + 1,000 x 0.3 = 400.
    expect(h.out.slice(-2)).toEqual(["Spent: $0.000400 counted against the $1.000000 budget.", "The budget did not stop the run."]);
  });
});

describe("what a live --caps-probe and --record send (fix round #11)", () => {
  /** The attempt time limits main() asked for, and the one signal it got back for each. */
  function timeLimits(h: ReturnType<typeof harness>) {
    const limits: number[] = [];
    const signal = new AbortController().signal;
    h.deps.generateDeps = {
      ...FAST,
      timeoutSignal: (ms) => {
        limits.push(ms);
        return signal;
      },
    };
    return { limits, signal };
  }

  it("--caps-probe: the largest prompt (the caps snapshot with the repair lines), at most 256 output tokens, the attempt's time limit", async () => {
    const h = harness({ answer: async () => ({ json: undefined, model: "fake", usage: { inputTokens: 51_234, outputTokens: 256 }, stop: "max_tokens" }) });
    const { limits, signal } = timeLimits(h);
    expect(await main(["--caps-probe", "--live", "--max-usd", "1", "--only", GEMMA], h.deps)).toBe(0);
    expect(h.sent).toHaveLength(1);
    const { snapshot, request } = h.sent[0]!;
    expect(snapshot).toBe(CAPS_SNAPSHOT);
    expect(request).toEqual({ ...buildPrompt(CAPS_SNAPSHOT, CAPS_REPAIR), jsonSchema: AI_DRAFT_JSON_SCHEMA, maxOutputTokens: 256, signal });
    expect(request.signal).toBe(signal);
    expect(limits).toEqual([ATTEMPT_TIMEOUT_MS]);
    expect(ATTEMPT_TIMEOUT_MS).toBe(90_000);
  });

  it("--record: the ord-plumb prompt, at most MAX_OUTPUT_TOKENS output tokens, the attempt's time limit", async () => {
    const h = harness();
    const { limits, signal } = timeLimits(h);
    const ordPlumb = EVAL_PROFILES.find((p) => p.id === "ord-plumb")!.snapshot;
    expect(await main(["--record", "--live", "--max-usd", "1", "--only", GEMMA], h.deps)).toBe(0);
    expect(h.sent).toHaveLength(1);
    const { snapshot, request } = h.sent[0]!;
    expect(snapshot).toBe(ordPlumb);
    expect(request).toEqual({ ...buildPrompt(ordPlumb), jsonSchema: AI_DRAFT_JSON_SCHEMA, maxOutputTokens: MAX_OUTPUT_TOKENS, signal });
    expect(request.signal).toBe(signal);
    expect(limits).toEqual([ATTEMPT_TIMEOUT_MS]);
  });
});

describe("a live --record without usage (fix round #12)", () => {
  it("says when a response without usage was counted at its worst case", async () => {
    const body = { model: "m", choices: [{ message: { content: "{}" }, finish_reason: "stop" }] };
    const http = fakeFetch([{ status: 200, body }]);
    const recorded: Answer = async (env, snapshot, fetchImpl) => {
      await fetchImpl!("https://record.example.invalid/v1/chat/completions", { method: "POST", body: "{}" });
      return { ...(await validDraft(env, snapshot, fetchImpl)), usageMissing: true };
    };
    const h = harness({ answer: recorded, fetch: http.fetch });
    // groq's --record worst case: 70,000 x 0.15 + 8,192 x 0.6 = 15,415.2, so 15,416.
    expect(await main(["--record", "--live", "--max-usd", "1", "--only", GROQ], h.deps)).toBe(0);
    expect(h.out).toContain("groq/gpt-oss-120b: recorded test/fixtures/groq__gpt-oss-120b.json");
    expect(h.out).toContain("groq/gpt-oss-120b: the answer had no usage, so it was counted at its worst case of $0.015416");
    expect(h.out).toContain("Spent: $0.015416 counted against the $1.000000 budget.");
  });
});

describe("--caps-probe and --record build a provider only once the budget lets its request go (fix round #3, #15)", () => {
  it.each([
    ["--caps-probe", `${OPUS}: not measured: the budget stopped the run`],
    ["--record", `${OPUS}: nothing recorded: the budget stopped the run`],
  ])("%s: a model the budget refuses gets no provider, so it is reported as stopped by the budget, never as a build error", async (flag, line) => {
    const h = harness({ answer: async () => ({ json: undefined, model: "fake", usage: { inputTokens: 51_234, outputTokens: 256 }, stop: "max_tokens" }) });
    const build = h.deps.makeProvider;
    h.deps.makeProvider = (env, snapshot, fetchImpl) => {
      if (env.MODEL_ID === byLabel(OPUS).modelId) throw new ProviderError("auth", "a key an HTTP header cannot carry");
      return build(env, snapshot, fetchImpl);
    };
    await main([flag, "--live", "--max-usd", "0.03", "--only", `${OPUS},${GEMMA}`], h.deps);
    expect([h.built, h.requests]).toEqual([modelIds([GEMMA]), modelIds([GEMMA])]);
    expect(h.out).toContain(line);
    expect(h.out.join("\n")).not.toContain("auth");
  });
});

describe("the Anthropic SDK's environment (additions A)", () => {
  // The SDK 0.128.0 client reads these when it is built (client.mjs:70, 80, 109, 116).
  const NAMES = ["ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_LOG", "ANTHROPIC_BASE_URL"] as const;
  const present = () => NAMES.filter((name) => name in process.env);

  /** Runs `body` with a marker in each variable, and puts back what was there before, whatever happens. */
  async function withMarkers(body: () => Promise<void>): Promise<void> {
    const before = NAMES.map((name) => [name, process.env[name]] as const);
    try {
      for (const name of NAMES) process.env[name] = `marker-${name.toLowerCase()}`;
      expect(present()).toEqual([...NAMES]);
      await body();
    } finally {
      for (const [name, value] of before) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  it("deletes each variable from process.env before the first provider is built", async () => {
    await withMarkers(async () => {
      const seen: string[][] = [];
      const h = harness({ answer: async () => ({ json: undefined, model: "fake", usage: { inputTokens: 51_234, outputTokens: 256 }, stop: "max_tokens" }) });
      const build = h.deps.makeProvider;
      h.deps.makeProvider = (env, snapshot, fetchImpl) => {
        seen.push(present());
        return build(env, snapshot, fetchImpl);
      };
      expect(await main(["--caps-probe", "--live", "--max-usd", "1", "--only", `${GEMMA},${GROQ}`], h.deps)).toBe(0);
      expect(seen).toEqual([[], []]);
    });
  });

  it("deletes them at the start of every run, a dry run or a refused one included", async () => {
    for (const argv of [[], ["--live"]]) {
      await withMarkers(async () => {
        await main(argv, harness().deps);
        expect(present()).toEqual([]);
      });
    }
  });
});
