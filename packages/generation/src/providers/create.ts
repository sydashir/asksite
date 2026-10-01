import type { GenerationInputSnapshot } from "@asksite/core";
import { ProviderError, type ModelProvider } from "../provider.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { FAKE_MODES, FakeProvider, type FakeMode } from "./fake.ts";
import { OpenAICompatibleProvider } from "./openai-compatible.ts";

/** The generator Worker's variables and secrets that choose and configure the model (§6.2, §10.3). */
export interface ProviderEnv {
  ENVIRONMENT: string;
  MODEL_PROVIDER: string;
  MODEL_ID: string;
  OPENAI_COMPAT_BASE_URL?: string;
  FAKE_MODE?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_COMPAT_API_KEY?: string;
}

const isFakeMode = (mode: string): mode is FakeMode => (FAKE_MODES as readonly string[]).includes(mode);

/**
 * Throws a ProviderError for a missing key or a bad configuration; the job treats that as a
 * provider failure. `fetchImpl` is for the eval's response recorder; production leaves it out.
 */
export function createProvider(env: ProviderEnv, snapshot: GenerationInputSnapshot, fetchImpl?: typeof fetch): ModelProvider {
  const withFetch = fetchImpl === undefined ? {} : { fetch: fetchImpl };
  switch (env.MODEL_PROVIDER) {
    case "anthropic":
      if (!env.ANTHROPIC_API_KEY) throw new ProviderError("auth", "ANTHROPIC_API_KEY is not set");
      return new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.MODEL_ID, ...withFetch });
    case "openai-compatible":
      if (!env.OPENAI_COMPAT_API_KEY) throw new ProviderError("auth", "OPENAI_COMPAT_API_KEY is not set");
      if (!env.OPENAI_COMPAT_BASE_URL) throw new ProviderError("bad_request", "OPENAI_COMPAT_BASE_URL is not set");
      return new OpenAICompatibleProvider({ baseUrl: env.OPENAI_COMPAT_BASE_URL, apiKey: env.OPENAI_COMPAT_API_KEY, model: env.MODEL_ID, ...withFetch });
    case "fake": {
      // Fails closed: the fake needs no key, so only the exact values "development" and "test" may build it.
      if (env.ENVIRONMENT !== "development" && env.ENVIRONMENT !== "test") throw new ProviderError("bad_request", "The fake provider is allowed only in development and test");
      const mode = env.FAKE_MODE ?? "ok";
      if (!isFakeMode(mode)) throw new ProviderError("bad_request", "Unknown FAKE_MODE");
      return new FakeProvider(mode, snapshot);
    }
    default:
      throw new ProviderError("bad_request", "Unknown MODEL_PROVIDER");
  }
}
