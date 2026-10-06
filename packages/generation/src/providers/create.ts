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
  // Fails closed (user decision 4): production allows only Anthropic, whose terms bar training on customer content. Any
  // other provider builds only when ENVIRONMENT is exactly "development" or "test", so a missing, empty, mistyped or
  // differently cased value refuses it. Checked before any key is read, so no call can follow a refusal.
  if (env.MODEL_PROVIDER !== "anthropic" && env.ENVIRONMENT !== "development" && env.ENVIRONMENT !== "test")
    throw new ProviderError("bad_request", "Only the anthropic provider is allowed outside development and test");
  switch (env.MODEL_PROVIDER) {
    case "anthropic":
      if (!env.ANTHROPIC_API_KEY) throw new ProviderError("auth", "ANTHROPIC_API_KEY is not set");
      return new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.MODEL_ID, ...withFetch });
    case "openai-compatible":
      if (!env.OPENAI_COMPAT_API_KEY) throw new ProviderError("auth", "OPENAI_COMPAT_API_KEY is not set");
      if (!env.OPENAI_COMPAT_BASE_URL) throw new ProviderError("bad_request", "OPENAI_COMPAT_BASE_URL is not set");
      return new OpenAICompatibleProvider({ baseUrl: env.OPENAI_COMPAT_BASE_URL, apiKey: env.OPENAI_COMPAT_API_KEY, model: env.MODEL_ID, ...withFetch });
    case "fake": {
      // The fake needs no key; the check above already limits it to development and test.
      const mode = env.FAKE_MODE ?? "ok";
      if (!isFakeMode(mode)) throw new ProviderError("bad_request", "Unknown FAKE_MODE");
      return new FakeProvider(mode, snapshot);
    }
    default:
      throw new ProviderError("bad_request", "Unknown MODEL_PROVIDER");
  }
}
