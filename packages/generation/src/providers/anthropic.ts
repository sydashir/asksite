import Anthropic from "@anthropic-ai/sdk";
import { ATTEMPT_TIMEOUT_MS } from "../generate.ts";
import { modelSettings } from "../models.ts";
import { ProviderError, type ModelProvider, type ModelRequest, type ModelResponse, type ProviderErrorKind } from "../provider.ts";
import { dropNulls, toWireSchema } from "../wire-schema.ts";
import { statusKind } from "./shared.ts";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  /** Tests pass a stand-in; production uses the runtime's fetch. */
  fetch?: typeof fetch;
}

/**
 * The SDK's own default host (its baseURL defaults to process.env['ANTHROPIC_BASE_URL'] ??
 * https://api.anthropic.com), passed explicitly so an environment variable can never send our
 * requests, and the key with them, to another host.
 */
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

const STOP: Record<string, ModelResponse["stop"]> = { end_turn: "end", max_tokens: "max_tokens", refusal: "refusal" };

/** A provider error type a message may carry: a short plain token such as "billing_error", never provider text. */
const SAFE_ERROR_TYPE = /^[a-z0-9_.-]{1,64}$/;

/**
 * The usage tier's monthly spend cap (platform.claude.com api/rate-limits.md, "Reaching your spend
 * cap"): a 429 rate_limit_error with no retry-after that keeps failing until a human acts.
 */
const SPEND_CAP_CODE = "enforced_spend_limit_reached";

/** An own property of a parsed JSON value, or undefined: the error body's shape is never trusted. */
const own = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;

/** A 429 whose body (APIError.error, the parsed JSON) has error.details.error_code === SPEND_CAP_CODE. */
const isSpendCap = (error: unknown): boolean =>
  error instanceof Anthropic.APIError && error.status === 429 && own(own(own(error.error, "error"), "details"), "error_code") === SPEND_CAP_CODE;

/**
 * The shared status rule (statusKind), after the tier spend cap, which needs a human like a bad key. Every 400 is a
 * bad request, a spend limit you set included (api/errors.md: invalid_request_error "may also be used for other 4XX
 * status codes not listed").
 */
function kindOf(error: unknown): ProviderErrorKind {
  if (error instanceof Anthropic.APIUserAbortError || error instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (error instanceof Anthropic.APIConnectionError) return "unavailable";
  if (!(error instanceof Anthropic.APIError) || error.status === undefined) return "unavailable";
  return isSpendCap(error) ? "auth" : statusKind(error.status);
}

/**
 * The kind, the HTTP status, the provider's error type and the spend-cap code: never the key, the
 * provider's own text or headers.
 */
function failureMessage(kind: ProviderErrorKind, error: unknown): string {
  const details: string[] = [kind];
  if (error instanceof Anthropic.APIError) {
    if (error.status !== undefined) details.push(`HTTP ${error.status}`);
    const type: unknown = error.type;
    if (typeof type === "string" && SAFE_ERROR_TYPE.test(type)) details.push(type);
    if (isSpendCap(error)) details.push(SPEND_CAP_CODE);
  }
  return `Anthropic request failed (${details.join(", ")})`;
}

/** A token count as reported, or undefined when it is missing or not a finite number of at least 0. */
const tokenCount = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

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
      // The SDK reads ANTHROPIC_AUTH_TOKEN (an extra Authorization header) and ANTHROPIC_LOG (debug
      // logs hold the prompt) from process.env only when these options are undefined, so both are
      // explicit. ANTHROPIC_CUSTOM_HEADERS has no such option and is not neutralised here.
      authToken: null,
      logLevel: "off",
      baseURL: ANTHROPIC_BASE_URL,
      maxRetries: 0,
      timeout: ATTEMPT_TIMEOUT_MS,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const effort = modelSettings("anthropic", this.#model)?.anthropicEffort;
    // Our own code runs before the try, so an error in it propagates instead of becoming a ProviderError.
    const schema = toWireSchema(req.jsonSchema);
    let message: Anthropic.Message;
    try {
      message = await this.#client.messages.create(
        {
          model: this.#model,
          max_tokens: req.maxOutputTokens,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
          output_config: { format: { type: "json_schema", schema }, ...(effort === undefined ? {} : { effort }) },
        },
        { signal: req.signal },
      );
    } catch (error) {
      const kind = kindOf(error);
      throw new ProviderError(kind, failureMessage(kind, error));
    }
    const text = message.content.find((block) => block.type === "text")?.text;
    const reason = message.stop_reason ?? "";
    const stop = Object.hasOwn(STOP, reason) ? STOP[reason]! : "other";
    // The SDK types usage as always present but passes the body through unchecked: a missing or
    // invalid count is reported as 0 with usageMissing (P3-4a), never as a thrown error.
    const usage: { input_tokens?: unknown; output_tokens?: unknown } | null | undefined = message.usage;
    const inputTokens = tokenCount(usage?.input_tokens);
    const outputTokens = tokenCount(usage?.output_tokens);
    return {
      json: stop === "end" ? parseJson(text) : undefined,
      model: message.model,
      usage: { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 },
      stop,
      ...(inputTokens === undefined || outputTokens === undefined ? { usageMissing: true as const } : {}),
    };
  }
}
