import type { GenerationInputSnapshot } from "@asksite/core";
import { describe, expect, it } from "vitest";
import { Budget, CAPS_PROBE_OUTPUT_TOKENS, describeStop, formatUsd, parseMaxUsd, requestWorstCaseMicrousd, usageCostMicrousd, type BudgetStop } from "../eval/budget.ts";
import { formatReport, summarise } from "../eval/metrics.ts";
import { EVAL_PROFILES } from "../eval/profiles.ts";
import { runEval, type EvalCandidate } from "../eval/run.ts";
import { MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS } from "../src/generate.ts";
import { costMicrousd, worstCaseJobMicrousd } from "../src/models.ts";
import type { ModelProvider, ModelResponse } from "../src/provider.ts";
import { templateAnswer } from "../src/template.ts";

// Amendment P3-17: live eval requests are sent only under a --max-usd budget. Fakes only: no provider in this file
// makes a request of any kind.

const FAST = { sleep: async () => {}, timeoutSignal: () => new AbortController().signal, now: () => 0 };

/** Deterministic PRNG (mulberry32, as ratings.ts uses), so a failing case replays from its seed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const OPUS = { provider: "anthropic", modelId: "claude-opus-5-5" } as const;
const GEMMA = { provider: "openai-compatible", modelId: "@cf/google/gemma-4-26b-a4b-it" } as const;
const OPUS_SITE = worstCaseJobMicrousd(OPUS.provider, OPUS.modelId)!;
const GEMMA_SITE = worstCaseJobMicrousd(GEMMA.provider, GEMMA.modelId)!;

describe("parseMaxUsd", () => {
  it.each([
    ["5", 5_000_000],
    ["0.01", 10_000],
    ["2.5", 2_500_000],
    ["2.50", 2_500_000],
    ["0.29", 290_000],
    ["10.07", 10_070_000],
    ["007", 7_000_000],
    ["9007199254.74", 9_007_199_254_740_000],
  ])("reads %s as %i micro-US$, exactly", (text, micro) => {
    expect(parseMaxUsd(text)).toBe(micro);
  });

  it.each([
    "0", "0.0", "0.00", "00", "-1", "-0.5", "+5", "1e3", "1E3", "NaN", "Infinity", "", " 5", "5 ", "1.234", "0.001",
    ".5", "5.", "1,5", "0x10", "1_000", String.fromCharCode(0xff15), "9007199254.75", "99999999999999999999",
  ])("refuses %j", (text) => {
    expect(parseMaxUsd(text)).toBeNull();
  });
});

describe("formatUsd", () => {
  it("prints whole micro-US$ as US$ exactly, to the micro-dollar", () => {
    expect(formatUsd(1_331_520)).toBe("$1.331520");
    expect(formatUsd(0)).toBe("$0.000000");
    expect(formatUsd(5)).toBe("$0.000005");
    expect(formatUsd(79_891_200)).toBe("$79.891200");
    expect(formatUsd(Number.MAX_SAFE_INTEGER)).toBe("$9007199254.740991");
  });
});

describe("the worst cases of one request (P3-17 D1, D3)", () => {
  it("prices a site at worstCaseJobMicrousd, a caps-probe request at MAX_INPUT_TOKENS in and 256 out, a --record request at MAX_INPUT_TOKENS in and MAX_OUTPUT_TOKENS out", () => {
    expect(OPUS_SITE).toBe(3 * (70_500 * 4 + 8_192 * 20));
    expect(CAPS_PROBE_OUTPUT_TOKENS).toBe(256);
    expect(requestWorstCaseMicrousd(OPUS.provider, OPUS.modelId, CAPS_PROBE_OUTPUT_TOKENS)).toBe(70_500 * 4 + 256 * 20);
    expect(requestWorstCaseMicrousd(OPUS.provider, OPUS.modelId, MAX_OUTPUT_TOKENS)).toBe(70_500 * 4 + 8_192 * 20);
    expect(requestWorstCaseMicrousd(GEMMA.provider, GEMMA.modelId, CAPS_PROBE_OUTPUT_TOKENS)).toBe(costMicrousd(GEMMA.provider, GEMMA.modelId, { inputTokens: MAX_INPUT_TOKENS, outputTokens: 256 }));
  });

  it("has no worst case for a model with no recorded price", () => {
    expect(requestWorstCaseMicrousd("anthropic", "claude-unpriced", CAPS_PROBE_OUTPUT_TOKENS)).toBeNull();
    expect(requestWorstCaseMicrousd("openai-compatible", "constructor", MAX_OUTPUT_TOKENS)).toBeNull();
  });
});

describe("usageCostMicrousd, what a usage cost as the budget counts it (B)", () => {
  it("prices countable usage exactly as costMicrousd does", () => {
    for (const usage of [
      { inputTokens: 0, outputTokens: 0 },
      { inputTokens: 1_000, outputTokens: 1_000 },
      { inputTokens: 70_010, outputTokens: 256 },
      { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 },
    ])
      expect(usageCostMicrousd(GEMMA.provider, GEMMA.modelId, usage)).toBe(costMicrousd(GEMMA.provider, GEMMA.modelId, usage));
  });

  it.each([Number.NaN, -1, -1_000_000, 0.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53])(
    "is NaN, a cost the budget cannot count, when a token count is %s, even where the price would give a countable number",
    (count) => {
      expect(usageCostMicrousd(GEMMA.provider, GEMMA.modelId, { inputTokens: count, outputTokens: 1_000 })).toBeNaN();
      expect(usageCostMicrousd(GEMMA.provider, GEMMA.modelId, { inputTokens: 1_000, outputTokens: count })).toBeNaN();
    },
  );
});

const spent = (actualMicrousd: number, usageMissing = false) => () => ({ actualMicrousd, usageMissing });
/** One request through the budget that answers "sent" and cost `actual`. */
const pay = (budget: Budget, at: string, worst: number | null, actual: number, usageMissing = false) => budget.send(at, worst, async () => "sent", spent(actual, usageMissing));

describe("Budget", () => {
  it("sends a request whose worst case exactly fits, and stops before one whose worst case passes the cap by 1 micro-US$", async () => {
    const exact = new Budget(1_000);
    expect(await pay(exact, "a", 600, 400)).toBe("sent");
    expect(await pay(exact, "b", 600, 600)).toBe("sent");
    expect([exact.spentMicrousd, exact.stop]).toEqual([1_000, null]);
    const over = new Budget(999);
    expect(await pay(over, "a", 600, 400)).toBe("sent");
    expect(await pay(over, "b", 600, 600)).toBeUndefined();
    expect([over.spentMicrousd, over.stop]).toEqual([400, { at: "b", reason: "budget" }]);
  });

  it("stops for good: once a request does not fit, nothing more is sent, not even a cheaper one", async () => {
    const budget = new Budget(1_000);
    let calls = 0;
    const request = async () => {
      calls += 1;
      return "sent";
    };
    expect(await budget.send("big", 1_001, request, spent(0))).toBeUndefined();
    expect(await budget.send("small", 1, request, spent(0))).toBeUndefined();
    expect([calls, budget.spentMicrousd, budget.stop]).toEqual([0, 0, { at: "big", reason: "budget" }]);
  });

  it("counts a request whose usage is missing at its worst case", async () => {
    const budget = new Budget(10_000);
    expect(await pay(budget, "a", 3_000, 10, true)).toBe("sent");
    expect(budget.spentMicrousd).toBe(3_000);
  });

  it("counts a request without usage whose partial cost already passed its worst case at that partial cost, as an overrun (A)", async () => {
    for (const stopAfterOverrun of [true, false]) {
      const budget = new Budget(10_000, { stopAfterOverrun });
      expect(await pay(budget, "a", 1_000, 1_500, true)).toBe("sent");
      expect([budget.spentMicrousd, budget.overruns]).toEqual([1_500, [{ at: "a", countedMicrousd: 1_500, worstMicrousd: 1_000 }]]);
      expect(budget.stop).toEqual(stopAfterOverrun ? { at: "a", reason: "over_worst_case" } : null);
    }
  });

  it("counts a request that throws at its worst case, and passes the error on", async () => {
    const budget = new Budget(10_000);
    const boom = new Error("boom");
    await expect(budget.send("a", 3_000, async () => Promise.reject(boom), spent(0))).rejects.toBe(boom);
    expect([budget.spentMicrousd, budget.stop]).toEqual([3_000, null]);
  });

  it("stops at a request it cannot price: no recorded price, so no worst case", async () => {
    const budget = new Budget(10_000);
    let calls = 0;
    expect(await budget.send("unpriced", null, async () => (calls += 1), spent(0))).toBeUndefined();
    expect(await pay(budget, "priced", 1, 1)).toBeUndefined();
    expect([calls, budget.stop]).toEqual([0, { at: "unpriced", reason: "no_price" }]);
  });

  it("stops after a request that cost more than its worst case: the bound the gate relies on failed", async () => {
    const budget = new Budget(10_000);
    expect(await pay(budget, "a", 1_000, 1_500)).toBe("sent");
    expect([budget.spentMicrousd, budget.stop]).toEqual([1_500, { at: "a", reason: "over_worst_case" }]);
    expect(await pay(budget, "b", 1, 0)).toBeUndefined();
  });

  it("stops after a request that cost exactly 1 micro-US$ more than its worst case, not after one that cost exactly its worst case", async () => {
    const exact = new Budget(10_000);
    expect(await pay(exact, "a", 1_000, 1_000)).toBe("sent");
    expect([exact.spentMicrousd, exact.stop]).toEqual([1_000, null]);
    const over = new Budget(10_000);
    expect(await pay(over, "a", 1_000, 1_001)).toBe("sent");
    expect([over.spentMicrousd, over.stop]).toEqual([1_001, { at: "a", reason: "over_worst_case" }]);
    expect(await pay(over, "b", 1, 0)).toBeUndefined();
  });

  // Fail closed (fix round #4): costs are whole micro-US$ (costMicrousd rounds up), so the budget rounds nothing itself.
  // A cost that is not a safe integer of at least 0 counts at the request's worst case and stops the run, whether an
  // overrun would stop it or not.
  it.each([
    ["NaN", Number.NaN],
    ["a negative cost", -1_000_000],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["minus Infinity", Number.NEGATIVE_INFINITY],
    ["a fraction", 0.5],
    ["a cost above Number.MAX_SAFE_INTEGER", 2 ** 53],
  ])("fails closed on %s: counts the request at its worst case and stops the run", async (_name, actual) => {
    for (const stopAfterOverrun of [true, false])
      for (const usageMissing of [false, true]) {
        const budget = new Budget(1_000, { stopAfterOverrun });
        expect(await pay(budget, "a", 600, actual, usageMissing)).toBe("sent");
        expect([budget.spentMicrousd, budget.stop, budget.overruns]).toEqual([600, { at: "a", reason: "invalid_cost" }, []]);
        expect(await pay(budget, "b", 1, 0)).toBeUndefined();
        expect(budget.spentMicrousd).toBe(600);
      }
  });

  it.each([Number.NaN, -1, 0.5, Number.POSITIVE_INFINITY])("refuses a worst case of %s before sending anything", async (worst) => {
    const budget = new Budget(1_000);
    let calls = 0;
    await expect(budget.send("a", worst, async () => (calls += 1), spent(0))).rejects.toThrow(RangeError);
    expect([calls, budget.spentMicrousd, budget.stop]).toEqual([0, 0, null]);
  });

  it("names the stop for a cost it could not count", () => {
    expect(describeStop({ at: "gemma ord-plumb run 1", reason: "invalid_cost" })).toBe(
      "Stopped after gemma ord-plumb run 1: its cost was not a whole number of micro-US$ of at least 0, so it was counted at its worst case; nothing more was sent.",
    );
  });

  it("holds a request's worst case while it is in flight, so requests sent at once cannot pass the cap together", async () => {
    const budget = new Budget(1_000);
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = budget.send(
      "a",
      600,
      async () => {
        await held;
        return "a";
      },
      spent(100),
    );
    expect(budget.spentMicrousd).toBe(600);
    expect(await pay(budget, "b", 600, 100)).toBeUndefined();
    release();
    expect(await first).toBe("a");
    expect(budget.spentMicrousd).toBe(100);
  });

  it("refuses a cap that is not a whole number of micro-US$ above zero", () => {
    for (const cap of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) expect(() => new Budget(cap)).toThrow(RangeError);
  });

  it("never lets the spend pass the cap: 1,000 seeded runs of requests that each cost up to their worst case", async () => {
    const worsts = [OPUS_SITE, GEMMA_SITE, requestWorstCaseMicrousd(OPUS.provider, OPUS.modelId, CAPS_PROBE_OUTPUT_TOKENS)!, requestWorstCaseMicrousd(GEMMA.provider, GEMMA.modelId, MAX_OUTPUT_TOKENS)!];
    const broken: string[] = [];
    for (let seed = 1; seed <= 1_000; seed++) {
      const next = random(seed);
      const cap = 1 + Math.floor(next() * 4 * OPUS_SITE);
      const budget = new Budget(cap);
      let refused: number | null = null;
      for (let i = 0; i < 30; i++) {
        const worst = worsts[Math.floor(next() * worsts.length)]!;
        const actual = Math.floor(next() * (worst + 1));
        const usageMissing = next() < 0.25;
        const before = budget.spentMicrousd;
        const sent = await pay(budget, `r${i}`, worst, actual, usageMissing);
        if (sent === "sent" && (refused !== null || before + worst > cap || budget.spentMicrousd !== before + (usageMissing ? worst : actual))) broken.push(`seed ${seed}: r${i} sent wrongly`);
        if (sent === undefined && refused === null && before + worst <= cap) broken.push(`seed ${seed}: r${i} refused although it fit`);
        if (sent === undefined) refused ??= i;
        if (sent === undefined && budget.spentMicrousd !== before) broken.push(`seed ${seed}: r${i} refused but counted`);
        if (budget.spentMicrousd > cap) broken.push(`seed ${seed}: spent ${budget.spentMicrousd} > cap ${cap}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("a budget that goes on after an overrun (--caps-probe and --record; fix round #1)", () => {
  it("records a request that cost more than its worst case instead of stopping, and counts it in the next request's check", async () => {
    const budget = new Budget(10_000, { stopAfterOverrun: false });
    expect(await pay(budget, "a", 1_000, 1_500)).toBe("sent");
    expect([budget.spentMicrousd, budget.stop, budget.overruns]).toEqual([1_500, null, [{ at: "a", countedMicrousd: 1_500, worstMicrousd: 1_000 }]]);
    expect(await pay(budget, "b", 8_500, 8_000)).toBe("sent");
    // 9,500 + 501 > 10,000; had a's overrun been left out (a counted at 1,000), c would fit: 9,000 + 501.
    expect(await pay(budget, "c", 501, 0)).toBeUndefined();
    expect([budget.spentMicrousd, budget.stop, budget.overruns.length]).toEqual([9_500, { at: "c", reason: "budget" }, 1]);
  });

  it("never lets the spend pass the cap by more than the overrun of the last request sent: 1,000 seeded runs", async () => {
    const broken: string[] = [];
    for (let seed = 1; seed <= 1_000; seed++) {
      const next = random(seed);
      const cap = 1 + Math.floor(next() * 200_000);
      const budget = new Budget(cap, { stopAfterOverrun: false });
      const overran: string[] = [];
      let refused = false;
      for (let i = 0; i < 20; i++) {
        const worst = 1 + Math.floor(next() * 50_000);
        // One request in four costs more than its worst case, by up to its worst case again.
        const actual = next() < 0.25 ? worst + 1 + Math.floor(next() * worst) : Math.floor(next() * (worst + 1));
        const before = budget.spentMicrousd;
        const sent = await pay(budget, `r${i}`, worst, actual);
        if (sent === undefined) {
          if (!refused && before + worst <= cap) broken.push(`seed ${seed}: r${i} refused although it fit`);
          if (budget.spentMicrousd !== before) broken.push(`seed ${seed}: r${i} refused but counted`);
          refused = true;
          continue;
        }
        if (refused || before + worst > cap) broken.push(`seed ${seed}: r${i} sent although it did not fit`);
        if (budget.spentMicrousd !== before + actual) broken.push(`seed ${seed}: r${i} counted ${budget.spentMicrousd - before}, not ${actual}`);
        if (actual > worst) overran.push(`r${i}`);
        if (budget.spentMicrousd > cap + Math.max(0, actual - worst)) broken.push(`seed ${seed}: spent ${budget.spentMicrousd} > cap ${cap} + the overrun of r${i}`);
      }
      if (budget.stop !== null && budget.stop.reason !== "budget") broken.push(`seed ${seed}: stop ${JSON.stringify(budget.stop)}`);
      if (JSON.stringify(budget.overruns.map((o) => o.at)) !== JSON.stringify(overran)) broken.push(`seed ${seed}: overruns ${JSON.stringify(budget.overruns)}`);
    }
    expect(broken).toEqual([]);
  });
});

/** A provider that answers every request with the template answer (valid) and the same usage. */
const fixedAnswer = (snapshot: GenerationInputSnapshot, usage: ModelResponse["usage"], usageMissing = false): ModelResponse => ({
  json: templateAnswer(snapshot.facts, snapshot.brief),
  model: "fixed",
  usage,
  stop: "end",
  ...(usageMissing ? { usageMissing: true as const } : {}),
});

/** A candidate priced like `model` whose provider is a fake: counts each request in `requests`. */
function candidate(label: string, model: { provider: string; modelId: string }, answer: (snapshot: GenerationInputSnapshot) => ModelResponse, requests: string[]): EvalCandidate {
  return {
    label,
    ...model,
    makeProvider: (snapshot): ModelProvider => ({
      id: "fake",
      generate: async () => {
        requests.push(label);
        return answer(snapshot);
      },
    }),
  };
}

const THOUSAND = { inputTokens: 1_000, outputTokens: 1_000 };
const SITE_COST = costMicrousd(OPUS.provider, OPUS.modelId, THOUSAND);

describe("runEval with a budget (P3-17 D3, D4)", () => {
  it("sends a site only while its worst case still fits, then no site of any candidate", async () => {
    for (const [cap, sites] of [
      [OPUS_SITE + 3 * SITE_COST, 4],
      [OPUS_SITE + 3 * SITE_COST - 1, 3],
    ] as const) {
      const requests: string[] = [];
      const budget = new Budget(cap);
      const runs = await runEval({
        candidates: [candidate("opus", OPUS, (s) => fixedAnswer(s, THOUSAND), requests), candidate("gemma", GEMMA, (s) => fixedAnswer(s, THOUSAND), requests)],
        profiles: EVAL_PROFILES.slice(0, 3),
        runs: 2,
        deps: FAST,
        budget,
      });
      // opus's sites in order: profile 0 runs 1 and 2, profile 1 runs 1 and 2, profile 2 run 1, ...
      const order = [0, 0, 1, 1, 2].map((p, i) => `opus ${EVAL_PROFILES[p]!.id} run ${(i % 2) + 1}`);
      expect(runs.map((r) => `${r.candidate} ${r.profile.id} run ${r.run}`)).toEqual(order.slice(0, sites));
      expect(requests).toEqual(Array.from({ length: sites }, () => "opus"));
      expect(budget.spentMicrousd).toBe(sites * SITE_COST);
      expect(budget.stop).toEqual({ at: order[sites], reason: "budget" });
    }
  });

  it("counts a site that has an attempt without usage at its worst case", async () => {
    const requests: string[] = [];
    const budget = new Budget(2 * OPUS_SITE - 1);
    const runs = await runEval({ candidates: [candidate("opus", OPUS, (s) => fixedAnswer(s, THOUSAND, true), requests)], profiles: EVAL_PROFILES.slice(0, 2), runs: 1, deps: FAST, budget });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.costMicrousd).toBe(SITE_COST);
    expect([budget.spentMicrousd, budget.stop]).toEqual([OPUS_SITE, { at: `opus ${EVAL_PROFILES[1]!.id} run 1`, reason: "budget" }]);
  });

  it("builds no provider for a site the budget refuses", async () => {
    let built = 0;
    const opus: EvalCandidate = {
      label: "opus",
      ...OPUS,
      makeProvider: (snapshot) => {
        built += 1;
        return { id: "fake", generate: async () => fixedAnswer(snapshot, THOUSAND) };
      },
    };
    const runs = await runEval({ candidates: [opus], profiles: EVAL_PROFILES.slice(0, 2), runs: 1, deps: FAST, budget: new Budget(OPUS_SITE - 1) });
    expect([runs.length, built]).toEqual([0, 0]);
  });

  it("stops at a candidate with no recorded price by itself: no worst case, so no provider built and no site sent (fix round #6)", async () => {
    // The CLI already leaves unpriced models out of a live run; this is runEval's own check, the second layer.
    let built = 0;
    const requests: string[] = [];
    const unpriced: EvalCandidate = {
      label: "unpriced",
      provider: "anthropic",
      modelId: "claude-unpriced",
      makeProvider: (snapshot) => {
        built += 1;
        return { id: "fake", generate: async () => fixedAnswer(snapshot, THOUSAND) };
      },
    };
    const budget = new Budget(10 * OPUS_SITE);
    const runs = await runEval({ candidates: [unpriced, candidate("opus", OPUS, (s) => fixedAnswer(s, THOUSAND), requests)], profiles: EVAL_PROFILES.slice(0, 2), runs: 1, deps: FAST, budget });
    expect([runs.length, built, requests, budget.spentMicrousd]).toEqual([0, 0, [], 0]);
    expect(budget.stop).toEqual({ at: `unpriced ${EVAL_PROFILES[0]!.id} run 1`, reason: "no_price" });
  });

  it("never lets the spend pass the cap over seeded random sites, and counts each site as the gate says", async () => {
    const broken: string[] = [];
    for (let seed = 1; seed <= 12; seed++) {
      const next = random(seed);
      const requests: string[] = [];
      // Cut-off answers make three attempts per site, each with random usage up to the per-attempt bounds, so a site
      // can cost up to its worst case; some attempts come without usage.
      const cutOff = (): ModelResponse => ({
        json: undefined,
        model: "random",
        usage: { inputTokens: Math.floor(next() * (MAX_INPUT_TOKENS + 1)), outputTokens: Math.floor(next() * (MAX_OUTPUT_TOKENS + 1)) },
        stop: "max_tokens",
        ...(next() < 0.1 ? { usageMissing: true as const } : {}),
      });
      const models = [GEMMA, OPUS] as const;
      const candidates = models.map((m, i) => candidate(`c${i}`, m, cutOff, requests));
      const profiles = EVAL_PROFILES.slice(0, 3);
      const cap = 1 + Math.floor(next() * 5 * OPUS_SITE);
      const budget = new Budget(cap);
      const runs = await runEval({ candidates, profiles, runs: 2, deps: FAST, budget });
      const plan = candidates.flatMap((c, i) => profiles.flatMap((p) => [1, 2].map((run) => ({ label: c.label, at: `${c.label} ${p.id} run ${run}`, worst: worstCaseJobMicrousd(models[i]!.provider, models[i]!.modelId)! }))));
      let expected = 0;
      runs.forEach((r, i) => {
        const site = plan[i]!;
        if (`${r.candidate} ${r.profile.id} run ${r.run}` !== site.at) broken.push(`seed ${seed}: site ${i} out of order`);
        if (expected + site.worst > cap) broken.push(`seed ${seed}: ${site.at} sent although it did not fit`);
        expected += r.result.log.some((attempt) => attempt.usageMissing) ? site.worst : r.costMicrousd;
      });
      const stoppedAt: BudgetStop | null = runs.length < plan.length ? { at: plan[runs.length]!.at, reason: "budget" } : null;
      if (stoppedAt !== null && expected + plan[runs.length]!.worst <= cap) broken.push(`seed ${seed}: stopped although ${stoppedAt.at} fit`);
      if (JSON.stringify(budget.stop) !== JSON.stringify(stoppedAt)) broken.push(`seed ${seed}: stop ${JSON.stringify(budget.stop)}`);
      if (budget.spentMicrousd !== expected || expected > cap) broken.push(`seed ${seed}: spent ${budget.spentMicrousd}, expected ${expected}, cap ${cap}`);
      if (requests.length !== 3 * runs.length) broken.push(`seed ${seed}: ${requests.length} requests for ${runs.length} sites`);
    }
    expect(broken).toEqual([]);
  });
});

describe("the report's spend section (P3-17 D4, additions B)", () => {
  it("shows the budget, what it counted, each model's spend, the total, unknown usage, and where the budget stopped the run", async () => {
    const requests: string[] = [];
    // gemma's two sites lack usage, so each counts at its worst case; opus's second site then does not fit.
    const budget = new Budget(2 * GEMMA_SITE + SITE_COST + OPUS_SITE - 1);
    const runs = await runEval({
      candidates: [candidate("gemma", GEMMA, (s) => fixedAnswer(s, THOUSAND, true), requests), candidate("opus", OPUS, (s) => fixedAnswer(s, THOUSAND), requests)],
      profiles: EVAL_PROFILES.slice(0, 1),
      runs: 2,
      deps: FAST,
      budget,
    });
    expect(requests).toEqual(["gemma", "gemma", "opus"]);
    const gemmaCost = costMicrousd(GEMMA.provider, GEMMA.modelId, THOUSAND);
    const report = formatReport(summarise(runs), { budgetMicrousd: budget.capMicrousd, countedMicrousd: budget.spentMicrousd, stop: budget.stop });
    expect(report).toContain(`- Budget: ${formatUsd(budget.capMicrousd)}. Counted against it: ${formatUsd(2 * GEMMA_SITE + SITE_COST)} (a site with an attempt without usage counts at its worst case).`);
    expect(report).toContain(`- gemma: spent ${formatUsd(2 * gemmaCost)}, plus unknown (2 attempts without usage)\n`);
    expect(report).toContain(`- opus: spent ${formatUsd(SITE_COST)}\n`);
    expect(report).toContain(`- In total: spent ${formatUsd(2 * gemmaCost + SITE_COST)}, plus unknown (2 attempts without usage)\n`);
    expect(report).toContain(`- Stopped for the budget before opus ${EVAL_PROFILES[0]!.id} run 2: its worst case would have taken the spend over the budget, so nothing more was sent.`);
  });

  it("gives no gate verdict for a model with fewer sites than planned, and says what cut it (fix round #10)", async () => {
    const requests: string[] = [];
    const runs = await runEval({ candidates: [candidate("opus", OPUS, (s) => fixedAnswer(s, THOUSAND), requests)], profiles: EVAL_PROFILES.slice(0, 2), runs: 1, deps: FAST });
    expect(summarise(runs, 2)[0]!.meetsAutomaticGate).toBe(true);
    expect(summarise(runs, 3)[0]!.meetsAutomaticGate).toBeNull();
    expect(summarise(runs)[0]!.meetsAutomaticGate).toBe(true);
    const spend = { budgetMicrousd: OPUS_SITE, countedMicrousd: 2 * SITE_COST, stop: null };
    expect(formatReport(summarise(runs, 3), spend)).toContain("| not enough runs: cut by the budget |");
    expect(formatReport(summarise(runs, 3), { ...spend, error: "auth" })).toContain("| not enough runs: cut by an error |");
    expect(formatReport(summarise(runs, 2), spend)).toContain("| pass |");
  });

  it("says when the budget did not stop the run, and leaves the section out without a budget", async () => {
    const requests: string[] = [];
    const runs = await runEval({ candidates: [candidate("opus", OPUS, (s) => fixedAnswer(s, THOUSAND), requests)], profiles: EVAL_PROFILES.slice(0, 1), runs: 1, deps: FAST, budget: new Budget(OPUS_SITE) });
    const summaries = summarise(runs);
    expect(formatReport(summaries, { budgetMicrousd: OPUS_SITE, countedMicrousd: SITE_COST, stop: null })).toContain("- The budget did not stop the run.");
    expect(formatReport(summaries)).not.toContain("## Spend");
  });
});
