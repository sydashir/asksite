import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { GenerationInputSnapshot } from "@asksite/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPS_PROBE_OUTPUT_TOKENS, formatUsd, requestWorstCaseMicrousd } from "../eval/budget.ts";
import { CANDIDATES, type Candidate } from "../eval/candidates.ts";
import { main, type CliDeps } from "../eval/cli.ts";
import { EVAL_PROFILES } from "../eval/profiles.ts";
import { MAX_OUTPUT_TOKENS } from "../src/generate.ts";
import { worstCaseJobMicrousd } from "../src/models.ts";
import { ProviderError, type ModelResponse } from "../src/provider.ts";
import type { ProviderEnv } from "../src/providers/create.ts";
import { templateDraft } from "../src/template.ts";
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
  expect(globalFetchCalls).toEqual([]);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Stand-in keys for every candidate. They are markers: no output may ever contain one. */
const KEYS = { ANTHROPIC_API_KEY: "marker-anthropic-key", CLOUDFLARE_ACCOUNT_ID: "marker-account", CLOUDFLARE_AI_TOKEN: "marker-cf-token", GROQ_API_KEY: "marker-groq-key", HF_TOKEN: "marker-hf-token" };
const FAST = { sleep: async () => {}, timeoutSignal: () => new AbortController().signal, now: () => 0 };
const THOUSAND = { inputTokens: 1_000, outputTokens: 1_000 };
const byLabel = (label: string): Candidate => CANDIDATES.find((c) => c.label === label)!;
const OPUS = "claude-opus-5-5";
const GEMMA = "workers-ai/gemma-4-26b-a4b-it";
const GROQ = "groq/gpt-oss-120b";

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
  const answer = options.answer ?? validDraft;
  const deps: CliDeps = {
    env: options.env ?? KEYS,
    candidates: options.candidates ?? CANDIDATES,
    makeProvider: (env, snapshot, fetchImpl) => {
      built.push(env.MODEL_ID);
      return {
        id: "fake",
        generate: async () => {
          requests.push(env.MODEL_ID);
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
  return { deps, dir, built, requests, out, err, progress, text: () => [...out, ...err].join("\n") };
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
});

describe("a live caps probe (P3-17 D3)", () => {
  const measured: Answer = async () => ({ json: undefined, model: "fake", usage: { inputTokens: 51_234, outputTokens: 256 }, stop: "max_tokens" });

  it("sends one request per model, cheapest worst case first, and stops before the first that does not fit", async () => {
    const h = harness({ answer: measured });
    // Caps worst cases: gemma $0.007077, groq $0.010654, hf $0.010692, workers-ai gpt-oss $0.024692, ... Actual costs of
    // 51,234 in and 256 out: gemma 5,201, groq 7,839, hf 7,878 micro-US$ (20,918 in all); gpt-oss would then pass $0.03.
    expect(await main(["--caps-probe", "--live", "--max-usd", "0.03"], h.deps)).toBe(1);
    expect(h.requests).toEqual(modelIds([GEMMA, GROQ, "hf-router/gpt-oss-120b:groq"]));
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
    expect(await main(["--caps-probe", "--live", "--max-usd", "1"], h.deps)).toBe(1);
    expect(h.out).toContain(`${GEMMA}: unavailable, not measured`);
    expect(h.out).toContain(`${GROQ}: the answer had no usage, not measured`);
    expect(h.out).toContain(`${OPUS}: 70001 input tokens for the caps prompt (bound 70000) OVER THE BOUND`);
    const worst = (label: string) => requestWorstCaseMicrousd(byLabel(label).provider, byLabel(label).modelId, CAPS_PROBE_OUTPUT_TOKENS)!;
    const opusCost = Math.ceil(70_001 * 4 + 256 * 20);
    expect(h.out).toContain(`Spent: ${formatUsd(worst(GEMMA) + worst(GROQ) + opusCost)} counted against the $1.000000 budget.`);
    expect(h.out).toContain(`Stopped after ${OPUS}: it cost more than its worst case, so the budget can no longer bound the run; nothing more was sent.`);
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

  it("refuses a candidate with no recorded price and evaluates the others", async () => {
    const unpriced: Candidate = { label: "claude-unpriced", provider: "anthropic", modelId: "claude-unpriced", needs: ["ANTHROPIC_API_KEY"] };
    const h = harness({ candidates: [unpriced, byLabel(GEMMA)] });
    expect(await main(["--live", "--max-usd", "1", "--runs", "1"], h.deps)).toBe(0);
    expect(h.out).toContain("claude-unpriced: no recorded price: cannot be run live");
    expect(new Set(h.built)).toEqual(new Set([byLabel(GEMMA).modelId]));
    expect(h.requests).toHaveLength(20);
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
    expect(readdirSync(join(h.dir, "fixtures")).sort()).toEqual(["groq__gpt-oss-120b.json", "workers-ai__gemma-4-26b-a4b-it.json"]);
    const fixture = readFileSync(join(h.dir, "fixtures", "groq__gpt-oss-120b.json"), "utf8");
    expect(JSON.parse(fixture)).toEqual({ provider: "openai-compatible", modelId: "openai/gpt-oss-120b", status: 200, body });
    expect(fixture).not.toMatch(/marker-/);
    expect(h.out).toContain("groq/gpt-oss-120b: recorded test/fixtures/groq__gpt-oss-120b.json");
    expect(h.out).toContain(`${OPUS}: nothing recorded: the budget stopped the run`);
    expect(h.out).toContain("Spent: $0.001150 counted against the $0.030000 budget.");
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
