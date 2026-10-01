import type { ModelProvider, ModelRequest, ModelResponse } from "../../src/provider.ts";
import { ProviderError } from "../../src/provider.ts";

/** A provider that plays back a fixed list of answers or errors and records every request. */
export function scriptedProvider(steps: Array<ModelResponse | ProviderError | Error>): ModelProvider & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    id: "fake",
    requests,
    async generate(req) {
      requests.push(req);
      const step = steps[requests.length - 1];
      if (step === undefined) throw new Error("scriptedProvider: no more steps");
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

export const answer = (json: unknown, usage = { inputTokens: 100, outputTokens: 50 }): ModelResponse => ({ json, model: "scripted-1", usage, stop: "end" });
export { ProviderError };
