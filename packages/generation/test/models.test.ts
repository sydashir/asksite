import type { GenerationInputSnapshot, Issue } from "@asksite/core";
import { describe, expect, it } from "vitest";
import { CAPS_FILLS, CAPS_REPAIR, CAPS_SNAPSHOT, capsRepair, capsSnapshot } from "../eval/caps.ts";
import { MAX_ATTEMPTS, MAX_OUTPUT_TOKENS } from "../src/generate.ts";
import { costMicrousd, MAX_INPUT_TOKENS, MODELS, modelSettings, PROMPT_OVERHEAD_TOKENS, worstCaseJobMicrousd } from "../src/models.ts";
import { buildPrompt } from "../src/prompt.ts";
import { AI_DRAFT_JSON_SCHEMA, toWireSchema } from "../src/wire-schema.ts";

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** UTF-8 bytes of one attempt's input: the system prompt, the user prompt and the wire schema. */
const promptBytes = (snapshot: GenerationInputSnapshot, repair: readonly Issue[]): number => {
  const { system, user } = buildPrompt(snapshot, repair);
  return bytes(system) + bytes(user) + bytes(JSON.stringify(toWireSchema(AI_DRAFT_JSON_SCHEMA)));
};

describe("MAX_INPUT_TOKENS", () => {
  it.each(CAPS_FILLS)("covers the largest prompt the builder can make with every capped input filled with %j (a token is at least one UTF-8 byte)", (fill) => {
    expect(promptBytes(capsSnapshot(fill), capsRepair(fill)) + PROMPT_OVERHEAD_TOKENS).toBeLessThanOrEqual(MAX_INPUT_TOKENS);
  });

  it("is sized by CAPS_SNAPSHOT and CAPS_REPAIR: no fill makes a larger prompt than their euro signs", () => {
    const worst = promptBytes(CAPS_SNAPSHOT, CAPS_REPAIR);
    for (const fill of CAPS_FILLS) expect(promptBytes(capsSnapshot(fill), capsRepair(fill)), JSON.stringify(fill)).toBeLessThanOrEqual(worst);
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
      for (const key of Object.keys(extraBody ?? {})) expect(["model", "messages", "max_tokens", "response_format", "stream"]).not.toContain(key);
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
