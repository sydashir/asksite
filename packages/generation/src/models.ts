import { MAX_ATTEMPTS, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS } from "./generate.ts";
import type { ModelPrice } from "./provider.ts";

// The input bound is defined in generate.ts, whose run-time guard uses it: generate.ts importing this
// file would make an import cycle, as this file imports generate.ts. It is re-exported here unchanged.
export { MAX_INPUT_TOKENS, PROMPT_OVERHEAD_TOKENS } from "./generate.ts";

export interface ModelSettings {
  price: ModelPrice;
  /** Anthropic output_config.effort; left out for models that do not support it (Haiku 4.5; the effort docs list it as not supported). */
  anthropicEffort?: "low" | "medium" | "high";
  /** Extra top-level fields for an OpenAI-compatible request; they can never replace a field the adapter sets. */
  extraBody?: Readonly<Record<string, unknown>>;
}

const ANTHROPIC_PRICES = "https://platform.claude.com/docs/en/about-claude/pricing";
const price = (inputPerMillion: number, outputPerMillion: number, source: string): ModelPrice => ({
  inputMicrousdPerToken: inputPerMillion, // US$ per million tokens = micro-US$ per token
  outputMicrousdPerToken: outputPerMillion,
  source,
  checkedOn: "2026-09-24",
});

/**
 * Keyed by "<MODEL_PROVIDER>:<MODEL_ID>". Prices are for reporting and the cost ceiling only.
 *
 * Every Anthropic price below assumes no prompt caching and no server tools: the adapter (anthropic.ts) sends neither
 * a `cache_control` field nor a `tools` field, and test/anthropic.test.ts fails if either one is ever added to the
 * request body. A 5-minute cache write costs 1.25x the input price, a 1-hour write 2x, and a cache read 0.1x
 * (platform.claude.com/docs/en/build-with-claude/prompt-caching, checked 2026-09-26; per-model exceptions apply to
 * the read multiplier only, e.g. Claude Opus 5.5 reads at 0.05x, none of which change the "no caching" assumption
 * here). Turning caching or server tools on for a model needs its price entry updated first.
 */
export const MODELS: Readonly<Record<string, ModelSettings>> = {
  "anthropic:claude-opus-5-5": { price: price(4, 20, ANTHROPIC_PRICES), anthropicEffort: "low" },
  "anthropic:claude-sonnet-5": { price: price(2, 10, ANTHROPIC_PRICES), anthropicEffort: "low" },
  "anthropic:claude-haiku-4-5": { price: price(1, 5, ANTHROPIC_PRICES) },
  "openai-compatible:@cf/openai/gpt-oss-120b": { price: price(0.35, 0.75, "https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/") },
  "openai-compatible:@cf/google/gemma-4-26b-a4b-it": { price: price(0.1, 0.3, "https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/") },
  "openai-compatible:@cf/qwen/qwen3.8-27b": {
    price: price(0.45, 3.2, "https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/"),
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  },
  "openai-compatible:openai/gpt-oss-120b": {
    price: price(0.15, 0.6, "https://console.groq.com/docs/models"),
    extraBody: { reasoning_effort: "low" },
  },
  // The Hugging Face router pinned to Groq (":groq"); no extra fields, as pass-through is unverified.
  "openai-compatible:openai/gpt-oss-120b:groq": { price: price(0.15, 0.75, "https://router.huggingface.co/v1/models") },
  "fake:fake-template": { price: { inputMicrousdPerToken: 0, outputMicrousdPerToken: 0, source: "none", checkedOn: "2026-09-24" } },
};

export function modelSettings(provider: string, modelId: string): ModelSettings | undefined {
  const key = `${provider}:${modelId}`;
  return Object.hasOwn(MODELS, key) ? MODELS[key] : undefined;
}

/** Reporting cost of the usage, rounded up; 0 when no price is recorded for the model. */
export function costMicrousd(provider: string, modelId: string, usage: { inputTokens: number; outputTokens: number }): number {
  const settings = modelSettings(provider, modelId);
  if (settings === undefined) return 0;
  const { inputMicrousdPerToken, outputMicrousdPerToken } = settings.price;
  return Math.ceil(usage.inputTokens * inputMicrousdPerToken + usage.outputTokens * outputMicrousdPerToken);
}

/**
 * Hard ceiling of one job's cost (design §6.3), or null when the model has no recorded price: no
 * ceiling is ever made up, and callers (Plan 4's admin settings) never face an exception.
 */
export function worstCaseJobMicrousd(provider: string, modelId: string): number | null {
  const settings = modelSettings(provider, modelId);
  if (settings === undefined) return null;
  const { inputMicrousdPerToken, outputMicrousdPerToken } = settings.price;
  return Math.ceil(MAX_ATTEMPTS * (MAX_INPUT_TOKENS * inputMicrousdPerToken + MAX_OUTPUT_TOKENS * outputMicrousdPerToken));
}
