import { Brief, GOALS, TONES, type GenerationInputSnapshot, type Issue } from "@asksite/core";
import { Facts, TRADES } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { CAPS_FILLS, CAPS_REPAIR, CAPS_SNAPSHOT, capsRepair, capsSnapshot } from "../eval/caps.ts";
import { MAX_ATTEMPTS, MAX_OUTPUT_TOKENS } from "../src/generate.ts";
import { costMicrousd, MAX_INPUT_TOKENS, MODELS, modelSettings, PROMPT_OVERHEAD_TOKENS, worstCaseJobMicrousd } from "../src/models.ts";
import { buildPrompt } from "../src/prompt.ts";
import { AI_DRAFT_JSON_SCHEMA, toWireSchema } from "../src/wire-schema.ts";

const bytes = (s: string) => new TextEncoder().encode(s).length;
const SCHEMA_BYTES = bytes(JSON.stringify(toWireSchema(AI_DRAFT_JSON_SCHEMA)));

/** UTF-8 bytes of one attempt's input: the system prompt, the user prompt and the wire schema. */
const promptBytes = (snapshot: GenerationInputSnapshot, repair: readonly Issue[]): number => {
  const { system, user } = buildPrompt(snapshot, repair);
  return bytes(system) + bytes(user) + SCHEMA_BYTES;
};

/** The on/off builder choices. heroPhoto does not change the prompt today; it is here so a future change is caught. */
const TOGGLES = ["yearFounded", "licences", "insured", "emergency247", "freeEstimates", "testimonials", "photos", "heroPhoto"] as const;
type Toggle = (typeof TOGGLES)[number];
const PHOTO = { url: "https://media.example.com/a/p.webp", alt: "a", width: 1, height: 1 };

/** CAPS_SNAPSHOT's capped strings with one combination of builder choices. */
function withChoices(trade: Facts["trade"], tone: Brief["tone"], goal: Brief["goal"], on: (toggle: Toggle) => boolean): GenerationInputSnapshot {
  const { yearFounded: _year, heroPhoto: _hero, ...facts } = CAPS_SNAPSHOT.facts;
  return {
    facts: {
      ...facts,
      trade,
      licences: on("licences") ? [{ label: "L", number: "1" }] : [],
      insured: on("insured"),
      emergency247: on("emergency247"),
      freeEstimates: on("freeEstimates"),
      testimonials: on("testimonials") ? [{ quote: "q", name: "n" }] : [],
      photos: on("photos") ? [PHOTO] : [],
      ...(on("yearFounded") ? { yearFounded: 1998 } : {}),
      ...(on("heroPhoto") ? { heroPhoto: PHOTO } : {}),
    },
    brief: { ...CAPS_SNAPSHOT.brief, tone, goal },
  };
}

describe("MAX_INPUT_TOKENS", () => {
  it.each(CAPS_FILLS)("covers the largest prompt the builder can make with every capped input filled with %j (a token is at least one UTF-8 byte)", (fill) => {
    expect(promptBytes(capsSnapshot(fill), capsRepair(fill)) + PROMPT_OVERHEAD_TOKENS).toBeLessThanOrEqual(MAX_INPUT_TOKENS);
  });

  it("is sized by CAPS_SNAPSHOT and CAPS_REPAIR: no fill makes a larger prompt than their euro signs", () => {
    const worst = promptBytes(CAPS_SNAPSHOT, CAPS_REPAIR);
    for (const fill of CAPS_FILLS) expect(promptBytes(capsSnapshot(fill), capsRepair(fill)), JSON.stringify(fill)).toBeLessThanOrEqual(worst);
  });

  it(
    "no builder choice makes a larger prompt than CAPS_SNAPSHOT (every trade, tone and goal, each on/off choice)",
    () => {
      let largest = { bytes: 0, choice: "" };
      for (const trade of TRADES)
        for (const tone of TONES)
          for (const goal of GOALS)
            for (let mask = 0; mask < 2 ** TOGGLES.length; mask++) {
              const on = (toggle: Toggle): boolean => (mask & (1 << TOGGLES.indexOf(toggle))) !== 0;
              const size = promptBytes(withChoices(trade, tone, goal, on), CAPS_REPAIR);
              if (size > largest.bytes) largest = { bytes: size, choice: JSON.stringify({ trade, tone, goal, on: TOGGLES.filter((toggle) => on(toggle)) }) };
            }
      expect(largest.bytes, largest.choice).toBeLessThanOrEqual(promptBytes(CAPS_SNAPSHOT, CAPS_REPAIR));
    },
    60_000,
  );
});

describe("eval/caps.ts", () => {
  const { facts, brief } = CAPS_SNAPSHOT;
  /** One UTF-16 unit longer: one more of its last character (every fill is one unit). */
  const grow = (text: string): string => text + text.slice(-1);
  const withFacts = (patch: Partial<Facts>): GenerationInputSnapshot => ({ facts: { ...facts, ...patch }, brief });
  const withBrief = (patch: Partial<Brief>): GenerationInputSnapshot => ({ facts, brief: { ...brief, ...patch } });
  const changeAt = <T>(items: readonly T[], index: number, change: (item: T) => T): T[] => items.map((item, i) => (i === index ? change(item) : item));
  const shortest = (texts: readonly string[]): number => Math.min(...texts.map((text) => text.length));
  const { places } = facts.serviceArea;
  const { services } = facts;
  const comments = Object.entries(brief.comments);
  /** Both halves pass their real schemas. */
  const parses = (snapshot: GenerationInputSnapshot): boolean => Facts.safeParse(snapshot.facts).success && Brief.safeParse(snapshot.brief).success;

  // [capped input, its size in CAPS_SNAPSHOT, snapshots with one input (or one item of it) one unit or one item over]
  const CAPPED: Array<[string, number, GenerationInputSnapshot[]]> = [
    ["businessName", facts.businessName.length, [withFacts({ businessName: grow(facts.businessName) })]],
    ["city", facts.location.city.length, [withFacts({ location: { ...facts.location, city: grow(facts.location.city) } })]],
    ["each service-area place", shortest(places), places.map((_, i) => withFacts({ serviceArea: { ...facts.serviceArea, places: changeAt(places, i, grow) } }))],
    ["the number of places", places.length, [withFacts({ serviceArea: { ...facts.serviceArea, places: [...places, ...places.slice(0, 1)] } })]],
    ["each service name", shortest(services.map((s) => s.name)), services.map((_, i) => withFacts({ services: changeAt(services, i, (s) => ({ ...s, name: grow(s.name) })) }))],
    ["the number of services", services.length, [withFacts({ services: [...services, ...services.slice(0, 1)] })]],
    ["differentiator", (brief.differentiator ?? "").length, [withBrief({ differentiator: grow(brief.differentiator ?? "") })]],
    ["notes", (brief.notes ?? "").length, [withBrief({ notes: grow(brief.notes ?? "") })]],
    ["each comment", shortest(comments.map(([, text]) => text)), comments.map(([key, text]) => withBrief({ comments: { ...brief.comments, [key]: grow(text) } }))],
    ["the number of comments", comments.length, [withBrief({ comments: { ...brief.comments, z: "" } })]],
    ["each comment key", shortest(comments.map(([key]) => key)), comments.map((_, i) => withBrief({ comments: Object.fromEntries(changeAt(comments, i, ([key, text]) => [`${key}x`, text])) }))],
  ];

  it.each(CAPPED)("holds %s exactly at its schema's cap (%i): CAPS_SNAPSHOT passes Facts and Brief, one more fails", (_input, _cap, overCap) => {
    expect(parses(CAPS_SNAPSHOT)).toBe(true);
    expect(overCap.map((snapshot) => parses(snapshot))).toEqual(overCap.map(() => false));
  });

  /** The decoded path and message of each repair line, `- "<path>": "<message>"` (two JSON strings). */
  const repairParts = (issues: readonly Issue[]): Array<[string, string]> =>
    buildPrompt(CAPS_SNAPSHOT, issues)
      .user.split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => {
        const parts = /^- ("(?:[^"\\]|\\.)*"): ("(?:[^"\\]|\\.)*")$/.exec(line);
        if (parts === null) throw new Error(`Not a repair line: ${line}`);
        return [JSON.parse(parts[1]!) as string, JSON.parse(parts[2]!) as string];
      });

  it("holds every CAPS_REPAIR issue at the repair caps: a 70-unit path keeps 60, a 250-unit message keeps 200, 25 issues keep 20", () => {
    const kept = repairParts(Array.from({ length: 25 }, () => ({ path: ["p".repeat(70)], code: "custom", message: "m".repeat(250) })));
    const sizes = kept.map(([path, message]) => [path.length, message.length]);
    expect(sizes).toEqual(Array.from({ length: 20 }, () => [60, 200]));
    expect(CAPS_REPAIR.map((issue) => [issue.path.join(".").length, issue.message.length])).toEqual(sizes);
  });
});

describe("MODELS", () => {
  it("records a source page and a check date for every price", () => {
    for (const [key, { price }] of Object.entries(MODELS)) {
      expect(key).toMatch(/^(anthropic|openai-compatible|fake):/);
      expect(price.source === "none" || price.source.startsWith("https://")).toBe(true);
      expect(price.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("finds settings by provider and model id", () => {
    expect(modelSettings("anthropic", "claude-opus-5-5")?.price.inputMicrousdPerToken).toBe(4);
    expect(modelSettings("anthropic", "gpt-oss")).toBeUndefined();
    expect(modelSettings("anthropic", "constructor")).toBeUndefined();
  });

  it("never gives a model extra fields that would replace one the OpenAI-compatible adapter sets", () => {
    for (const { extraBody } of Object.values(MODELS))
      for (const key of Object.keys(extraBody ?? {}))
        expect(["model", "messages", "max_tokens", "max_completion_tokens", "n", "response_format", "stream"]).not.toContain(key);
  });
});

describe("costMicrousd", () => {
  it("charges input and output at the listed prices, rounded up to a whole micro-dollar", () => {
    expect(costMicrousd("anthropic", "claude-opus-5-5", { inputTokens: 5_000, outputTokens: 2_000 })).toBe(60_000);
    expect(costMicrousd("openai-compatible", "@cf/openai/gpt-oss-120b", { inputTokens: 3, outputTokens: 1 })).toBe(2);
  });

  it("reports 0 for a model without a recorded price (limits are counts, not money)", () => {
    expect(costMicrousd("anthropic", "claude-unknown", { inputTokens: 5_000, outputTokens: 2_000 })).toBe(0);
  });
});

describe("worstCaseJobMicrousd", () => {
  it("is MAX_ATTEMPTS attempts at the input and output caps", () => {
    expect(MAX_ATTEMPTS * (MAX_INPUT_TOKENS * 4 + MAX_OUTPUT_TOKENS * 20)).toBe(1_331_520);
    expect(worstCaseJobMicrousd("anthropic", "claude-opus-5-5")).toBe(1_331_520);
    expect(worstCaseJobMicrousd("anthropic", "claude-sonnet-5")).toBe(665_760);
    expect(worstCaseJobMicrousd("fake", "fake-template")).toBe(0);
  });

  it("is null, never a made-up ceiling and never an exception, for a model whose price is not recorded", () => {
    expect(worstCaseJobMicrousd("anthropic", "claude-unknown")).toBeNull();
    expect(worstCaseJobMicrousd("anthropic", "constructor")).toBeNull();
  });
});
