import { execFileSync } from "node:child_process";
import type { GenerationInputSnapshot } from "@asksite/core";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CANDIDATES, providerEnvFor } from "../eval/candidates.ts";
import { formatReport, percentile, ruleOf, summarise } from "../eval/metrics.ts";
import { EVAL_PROFILES } from "../eval/profiles.ts";
import { ratingSheet } from "../eval/ratings.ts";
import { runEval } from "../eval/run.ts";
import type { ModelProvider } from "../src/provider.ts";
import { FakeProvider, type FakeMode } from "../src/providers/fake.ts";

let clock = 0;
const deps = { sleep: async () => {}, timeoutSignal: () => new AbortController().signal, now: () => (clock += 250) };
const fakeCandidate = (label: string, mode: FakeMode) => ({ label, provider: "fake", modelId: "fake-template", makeProvider: (snapshot: GenerationInputSnapshot) => new FakeProvider(mode, snapshot) });

describe("runEval + summarise", () => {
  it("measures first-try and within-retries pass rates, failed rules and latency per candidate", async () => {
    const profiles = EVAL_PROFILES.slice(0, 4);
    const runs = await runEval({ candidates: [fakeCandidate("good", "ok"), fakeCandidate("shaky", "invalid-once"), fakeCandidate("broken", "error")], profiles, runs: 2, deps });
    expect(runs).toHaveLength(3 * 4 * 2);
    const [good, shaky, broken] = summarise(runs);
    expect(good).toMatchObject({ label: "good", runs: 8, firstTryPassRate: 1, passRate: 1, failedRules: {}, costPerPassingSiteMicrousd: 0, meetsAutomaticGate: true });
    expect(good!.latencyMsP50).toBe(250);
    expect(shaky).toMatchObject({ label: "shaky", firstTryPassRate: 0, passRate: 1, failedRules: { digits_or_links: 8 }, meetsAutomaticGate: false });
    expect(broken).toMatchObject({ label: "broken", passRate: 0, providerErrors: { unavailable: 24 }, costPerPassingSiteMicrousd: null, meetsAutomaticGate: false });
  });

  it("formats a readable report with the gate", async () => {
    const runs = await runEval({ candidates: [fakeCandidate("good", "ok")], profiles: EVAL_PROFILES.slice(0, 1), runs: 1, deps });
    const report = formatReport(summarise(runs));
    expect(report).toContain("| good | 1 | 100% | 100% |");
    expect(report).toContain("gate");
  });
});

describe("ruleOf", () => {
  it("names the rule an issue broke", () => {
    expect(ruleOf({ path: ["copy", "heroHeadline"], code: "too_big", message: "Too big" })).toBe("length");
    expect(ruleOf({ path: ["copy", "about"], code: "custom", message: "Copy must not contain numbers, currency symbols, @ or links; facts come from the owner" })).toBe("digits_or_links");
    expect(ruleOf({ path: ["copy", "about"], code: "custom", message: "Copy states something the owner's facts do not back: \"since\"" })).toBe("unbacked_claim");
    expect(ruleOf({ path: ["layout"], code: "custom", message: "The layout must include every section" })).toBe("layout");
    expect(ruleOf({ path: ["copy", "serviceDescriptions"], code: "custom", message: "must name every facts.services entry once" })).toBe("service_descriptions");
    expect(ruleOf({ path: [], code: "cut_off", message: "" })).toBe("cut_off");
    expect(ruleOf({ path: ["copy"], code: "invalid_type", message: "expected object" })).toBe("shape");
  });
});

describe("percentile", () => {
  it("uses the nearest-rank method", () => {
    expect(percentile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe("ratingSheet", () => {
  it("lists passing drafts in a seeded random order with the model hidden, and keeps a separate key", async () => {
    const runs = await runEval({ candidates: [fakeCandidate("a", "ok"), fakeCandidate("b", "error")], profiles: EVAL_PROFILES.slice(0, 3), runs: 1, deps });
    const { csv, key } = ratingSheet(runs, 42);
    expect(csv.split("\n")[0]).toBe("item,profile,facts,heroHeadline,heroSubheadline,ctaText,about,sectionIntros,serviceDescriptions,faq,sounds_local_1to5,specific_1to5,publish_as_is_1to5,states_unbacked_fact_yes_no");
    expect(csv.trimEnd().split("\n")).toHaveLength(1 + 3);
    expect(csv).not.toMatch(/fake|\ba\b,|\bb\b,/);
    expect(key.map((k) => k.candidate)).toEqual(["a", "a", "a"]);
    expect(ratingSheet(runs, 42)).toEqual({ csv, key });
  });

  it("neutralises spreadsheet formulas", async () => {
    const runs = await runEval({ candidates: [fakeCandidate("a", "ok")], profiles: EVAL_PROFILES.slice(0, 1), runs: 1, deps });
    const run = runs[0]!;
    if (run.result.ok) run.result.draft.copy.heroHeadline = "=HYPERLINK(1)";
    expect(ratingSheet(runs, 1).csv).toContain(`"'=HYPERLINK(1)"`);
  });
});

describe("candidates", () => {
  it("builds a provider configuration only when every needed variable is set", () => {
    const opus = CANDIDATES.find((c) => c.label === "claude-opus-5-5")!;
    expect(providerEnvFor(opus, {})).toBeNull();
    expect(providerEnvFor(opus, { ANTHROPIC_API_KEY: "k" })).toEqual({ ENVIRONMENT: "development", MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-opus-5-5", ANTHROPIC_API_KEY: "k" });
    const oss = CANDIDATES.find((c) => c.label === "workers-ai/gpt-oss-120b")!;
    expect(providerEnvFor(oss, { CLOUDFLARE_AI_TOKEN: "t" })).toBeNull();
    expect(providerEnvFor(oss, { CLOUDFLARE_AI_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "acc" })).toEqual({
      ENVIRONMENT: "development", MODEL_PROVIDER: "openai-compatible", MODEL_ID: "@cf/openai/gpt-oss-120b",
      OPENAI_COMPAT_BASE_URL: "https://api.cloudflare.com/client/v4/accounts/acc/ai/v1", OPENAI_COMPAT_API_KEY: "t",
    });
    const hf = CANDIDATES.find((c) => c.label === "hf-router/gpt-oss-120b:groq")!;
    expect(providerEnvFor(hf, { HF_TOKEN: "h" })).toEqual({
      ENVIRONMENT: "development", MODEL_PROVIDER: "openai-compatible", MODEL_ID: "openai/gpt-oss-120b:groq",
      OPENAI_COMPAT_BASE_URL: "https://router.huggingface.co/v1", OPENAI_COMPAT_API_KEY: "h",
    });
  });

  it("only lists models with a recorded price", async () => {
    const { modelSettings } = await import("../src/models.ts");
    for (const c of CANDIDATES) expect(modelSettings(c.provider, c.modelId)).toBeDefined();
  });
});

describe("pnpm eval:generation without keys", () => {
  it("says there is nothing to run and exits 0", () => {
    const cli = fileURLToPath(new URL("../eval/cli.ts", import.meta.url));
    const out = execFileSync(process.execPath, [cli], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
    expect(out).toContain("No model keys found");
  });
});

/** A candidate whose provider answers like FakeProvider "ok" but leaves the usage out, as an adapter flags with usageMissing. */
const noUsageCandidate = (label: string) => ({
  label,
  provider: "fake",
  modelId: "fake-template",
  makeProvider: (snapshot: GenerationInputSnapshot): ModelProvider => {
    const inner = new FakeProvider("ok", snapshot);
    return { id: "fake", generate: async (req) => ({ ...(await inner.generate(req)), usageMissing: true }) };
  },
});

describe("attempts without usage (additions B)", () => {
  it("counts them per model and shows that model's cost as unknown", async () => {
    const runs = await runEval({ candidates: [fakeCandidate("good", "ok"), noUsageCandidate("blind")], profiles: EVAL_PROFILES.slice(0, 2), runs: 1, deps });
    const summaries = summarise(runs);
    expect(summaries.map((s) => [s.label, s.usageMissingAttempts])).toEqual([["good", 0], ["blind", 2]]);
    const report = formatReport(summaries);
    expect(report).toContain("| good | 2 | 100% | 100% | 250 | 250 | $0.0000 | pass |");
    expect(report).toContain("| blind | 2 | 100% | 100% | 250 | 250 | unknown (2 attempts without usage) | pass |");
  });

  it("names a single attempt without usage in the singular", async () => {
    const runs = await runEval({ candidates: [noUsageCandidate("blind")], profiles: EVAL_PROFILES.slice(0, 1), runs: 1, deps });
    expect(formatReport(summarise(runs))).toContain("| blind | 1 | 100% | 100% | 250 | 250 | unknown (1 attempt without usage) | pass |");
  });
});
