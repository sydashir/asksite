import type { ProviderEnv } from "../src/providers/create.ts";

/**
 * Models the evaluation can compare (model-options note §7). Keys come only from the environment
 * (the gitignored .env at the repo root); a candidate whose variables are missing is skipped.
 * Only paid, no-training routes are listed: never send even made-up data to a free route that
 * may train on it.
 */
export interface Candidate {
  label: string;
  provider: "anthropic" | "openai-compatible";
  modelId: string;
  /** Environment variables this candidate needs. */
  needs: readonly string[];
  baseUrl?: (env: Record<string, string | undefined>) => string;
  keyVar?: string;
}

const workersAi = (label: string, modelId: string): Candidate => ({
  label,
  provider: "openai-compatible",
  modelId,
  needs: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AI_TOKEN"],
  baseUrl: (env) => `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
  keyVar: "CLOUDFLARE_AI_TOKEN",
});

export const CANDIDATES: readonly Candidate[] = [
  { label: "claude-opus-5-5", provider: "anthropic", modelId: "claude-opus-5-5", needs: ["ANTHROPIC_API_KEY"] },
  { label: "claude-sonnet-5", provider: "anthropic", modelId: "claude-sonnet-5", needs: ["ANTHROPIC_API_KEY"] },
  workersAi("workers-ai/gpt-oss-120b", "@cf/openai/gpt-oss-120b"),
  workersAi("workers-ai/gemma-4-26b-a4b-it", "@cf/google/gemma-4-26b-a4b-it"),
  workersAi("workers-ai/qwen3.8-27b", "@cf/qwen/qwen3.8-27b"),
  {
    label: "groq/gpt-oss-120b",
    provider: "openai-compatible",
    modelId: "openai/gpt-oss-120b",
    needs: ["GROQ_API_KEY"],
    baseUrl: () => "https://api.groq.com/openai/v1",
    keyVar: "GROQ_API_KEY",
  },
  {
    // The Hugging Face router, pinned to Groq by the ":groq" suffix: data use is then Groq's plus
    // Hugging Face's ("We do not store the request body or response"), never an unknown provider's.
    label: "hf-router/gpt-oss-120b:groq",
    provider: "openai-compatible",
    modelId: "openai/gpt-oss-120b:groq",
    needs: ["HF_TOKEN"],
    baseUrl: () => "https://router.huggingface.co/v1",
    keyVar: "HF_TOKEN",
  },
];

/** The ProviderEnv createProvider needs for this candidate, or null when a variable is missing. */
export function providerEnvFor(candidate: Candidate, env: Record<string, string | undefined>): ProviderEnv | null {
  if (candidate.needs.some((name) => !env[name])) return null;
  const base = { ENVIRONMENT: "development", MODEL_PROVIDER: candidate.provider, MODEL_ID: candidate.modelId };
  if (candidate.provider === "anthropic") return { ...base, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY! };
  return { ...base, OPENAI_COMPAT_BASE_URL: candidate.baseUrl!(env), OPENAI_COMPAT_API_KEY: env[candidate.keyVar!]! };
}
