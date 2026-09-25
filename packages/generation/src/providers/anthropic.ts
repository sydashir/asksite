import Anthropic from "@anthropic-ai/sdk";
import { ATTEMPT_TIMEOUT_MS } from "../generate.ts";
import { modelSettings } from "../models.ts";
import { ProviderError, type ModelProvider, type ModelRequest, type ModelResponse, type ProviderErrorKind } from "../provider.ts";
import { dropNulls, toWireSchema } from "../wire-schema.ts";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  /** Tests pass a stand-in; production uses the runtime's fetch. */
  fetch?: typeof fetch;
}

const STOP: Record<string, ModelResponse["stop"]> = { end_turn: "end", max_tokens: "max_tokens", refusal: "refusal" };

function kindOf(error: unknown): ProviderErrorKind {
  if (error instanceof Anthropic.APIUserAbortError || error instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (error instanceof Anthropic.APIConnectionError) return "unavailable";
  if (!(error instanceof Anthropic.APIError) || error.status === undefined) return "unavailable";
  if (error.status === 401 || error.status === 403) return "auth";
  if (error.status === 429) return "rate_limited";
  if (error.status === 400 || error.status === 404 || error.status === 413 || error.status === 422) return "bad_request";
  return "unavailable";
}

const parseJson = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  try {
    return dropNulls(JSON.parse(text));
  } catch {
    return undefined;
  }
};

/**
 * Claude through the official SDK: one Messages API call with structured output
 * (output_config.format, json_schema; checked 2026-09-24 on the structured-outputs page and in the
 * claude-api skill). No thinking parameter: Opus 5.5 always thinks and rejects "disabled"; effort
 * comes from the MODELS table. The SDK's own retries are off; generateDraft owns retries.
 */
export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";
  readonly #client: Anthropic;
  readonly #model: string;

  constructor(options: AnthropicOptions) {
    this.#model = options.model;
    this.#client = new Anthropic({
      apiKey: options.apiKey,
      maxRetries: 0,
      timeout: ATTEMPT_TIMEOUT_MS,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const effort = modelSettings("anthropic", this.#model)?.anthropicEffort;
    let message: Anthropic.Message;
    try {
      message = await this.#client.messages.create(
        {
          model: this.#model,
          max_tokens: req.maxOutputTokens,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
          output_config: { format: { type: "json_schema", schema: toWireSchema(req.jsonSchema) }, ...(effort === undefined ? {} : { effort }) },
        },
        { signal: req.signal },
      );
    } catch (error) {
      const kind = kindOf(error);
      throw new ProviderError(kind, `Anthropic request failed (${kind}${error instanceof Anthropic.APIError && error.status !== undefined ? `, HTTP ${error.status}` : ""})`);
    }
    const text = message.content.find((block) => block.type === "text")?.text;
    const reason = message.stop_reason ?? "";
    const stop = Object.hasOwn(STOP, reason) ? STOP[reason]! : "other";
    return {
      json: stop === "end" ? parseJson(text) : undefined,
      model: message.model,
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
      stop,
    };
  }
}
