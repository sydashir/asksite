import type { GenerationInputSnapshot } from "@asksite/core";
import { ProviderError, type ModelProvider, type ModelRequest, type ModelResponse } from "../provider.ts";
import { templateAnswer } from "../template.ts";

export const FAKE_MODES = ["ok", "invalid-once", "invalid-always", "timeout", "error"] as const;
export type FakeMode = (typeof FAKE_MODES)[number];

/**
 * The offline provider for development and tests (design §6.2): it answers as a model does, with templateAnswer,
 * and FAKE_MODE scripts failures. "invalid-*" answers put a phone number in the headline, which
 * the validator rejects; "timeout" and "error" throw transient provider errors.
 */
export class FakeProvider implements ModelProvider {
  readonly id = "fake";
  readonly #mode: FakeMode;
  readonly #snapshot: GenerationInputSnapshot;
  #calls = 0;

  constructor(mode: FakeMode, snapshot: GenerationInputSnapshot) {
    this.#mode = mode;
    this.#snapshot = snapshot;
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    this.#calls += 1;
    if (req.signal.aborted || this.#mode === "timeout") throw new ProviderError("timeout", "fake provider timed out");
    if (this.#mode === "error") throw new ProviderError("unavailable", "fake provider is down");
    const answer = templateAnswer(this.#snapshot.facts, this.#snapshot.brief);
    const invalid = this.#mode === "invalid-always" || (this.#mode === "invalid-once" && this.#calls === 1);
    const json = invalid ? { ...answer, copy: { ...answer.copy, heroHeadline: "Call 555-0100 today" } } : answer;
    const usage = { inputTokens: req.system.length + req.user.length, outputTokens: JSON.stringify(json).length };
    return { json, model: "fake-template", usage, stop: "end" };
  }
}
