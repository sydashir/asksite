import Anthropic from "@anthropic-ai/sdk";
import { ATTEMPT_TIMEOUT_MS } from "../generate.ts";
import { modelSettings } from "../models.ts";
import { ProviderError, type ModelProvider, type ModelRequest, type ModelResponse, type ProviderErrorKind } from "../provider.ts";
import { dropNulls, toWireSchema } from "../wire-schema.ts";
import { checkApiKey, sharesKeyFragment, statusKind, tokenCount } from "./shared.ts";

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

/**
 * stop_reason values (api/messages). model_context_window_exceeded: "The response filled the model's context window",
 * and the docs say "Treat the response as truncated" (build-with-claude/handling-stop-reasons), so it is a cut-off
 * answer, like max_tokens. Any other value (stop_sequence, tool_use, pause_turn, null or unknown) is "other".
 */
const STOP: Record<string, ModelResponse["stop"]> = { end_turn: "end", max_tokens: "max_tokens", model_context_window_exceeded: "max_tokens", refusal: "refusal" };

/** A provider error type a message may carry: a short plain token such as "billing_error", never provider text. */
const SAFE_ERROR_TYPE = /^[a-z0-9_.-]{1,64}$/;

/**
 * The usage tier's monthly spend cap (platform.claude.com api/rate-limits.md, "Reaching your spend
 * cap"): a 429 rate_limit_error with no retry-after that keeps failing until the next calendar month
 * or until a human raises the limit ("API usage pauses until 00:00 UTC on the first day of the next
 * month, unless you request a higher limit sooner").
 */
const SPEND_CAP_CODE = "enforced_spend_limit_reached";

/**
 * A spend limit you set (api/rate-limits.md, "Setting your own spend limit"): "requests return HTTP 400 with error type
 * `invalid_request_error`. The message begins `You have reached your specified API usage limits`, or `You have reached
 * your specified workspace API usage limits` for a workspace limit". It stays a bad request, never retried, and the
 * error message names our fixed token SPEND_LIMIT_TOKEN, never the provider's text.
 */
const SPEND_LIMIT_PREFIXES = ["You have reached your specified API usage limits", "You have reached your specified workspace API usage limits"];
const SPEND_LIMIT_TOKEN = "SPEND_CAP";

/** An own property of a parsed JSON value, or undefined: a body's shape is never trusted. */
const own = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;

/** A 429 whose body (APIError.error, the parsed JSON) has error.details.error_code === SPEND_CAP_CODE. */
const isSpendCap = (error: unknown): boolean =>
  error instanceof Anthropic.APIError && error.status === 429 && own(own(own(error.error, "error"), "details"), "error_code") === SPEND_CAP_CODE;

/** A 400 whose body's error.message begins with one of SPEND_LIMIT_PREFIXES. */
const isSpendLimit = (error: unknown): boolean => {
  if (!(error instanceof Anthropic.APIError) || error.status !== 400) return false;
  const text = own(own(error.error, "error"), "message");
  return typeof text === "string" && SPEND_LIMIT_PREFIXES.some((prefix) => text.startsWith(prefix));
};

/**
 * The shared status rule (statusKind), after a redirect we did not follow (a wrong host) and the tier spend cap, which
 * needs a human like a bad key. Every 400 is a bad request, a spend limit you set included (api/errors.md:
 * invalid_request_error "may also be used for other 4XX status codes not listed").
 */
function kindOf(error: unknown): ProviderErrorKind {
  if (error instanceof Anthropic.APIUserAbortError || error instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (error instanceof Anthropic.APIConnectionError) return "unavailable";
  if (!(error instanceof Anthropic.APIError) || error.status === undefined) return "unavailable";
  if (error.status < 400) return "bad_request";
  return isSpendCap(error) ? "auth" : statusKind(error.status);
}

/**
 * The kind, the HTTP status, the provider's error type, the spend-cap code and, for a spend limit you set, our own
 * SPEND_LIMIT_TOKEN: never the key, the provider's own text or headers. A type or code that shares a fragment with the
 * key (sharesKeyFragment) is left out too.
 */
function failureMessage(kind: ProviderErrorKind, error: unknown, apiKey: string): string {
  const details: string[] = [kind];
  if (error instanceof Anthropic.APIError) {
    if (error.status !== undefined) details.push(`HTTP ${error.status}`);
    const type: unknown = error.type;
    if (typeof type === "string" && SAFE_ERROR_TYPE.test(type) && !sharesKeyFragment(type, apiKey)) details.push(type);
    if (isSpendCap(error) && !sharesKeyFragment(SPEND_CAP_CODE, apiKey)) details.push(SPEND_CAP_CODE);
    if (isSpendLimit(error)) details.push(SPEND_LIMIT_TOKEN);
  }
  return `Anthropic request failed (${details.join(", ")})`;
}

const parseJson = (text: unknown): unknown => {
  if (typeof text !== "string") return undefined;
  try {
    return dropNulls(JSON.parse(text));
  } catch {
    return undefined;
  }
};

/** The body parsed as JSON, or undefined when it cannot be read (a dropped connection, our abort) or is not JSON. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text());
  } catch {
    return undefined;
  }
}

/**
 * A cache count, added to the input tokens (P3-11 i). api/messages: "Total input tokens in a request is the summation
 * of `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`", and all three are billed (prompt
 * caching prices a cache write at 1.25 or 2 times the input price, a read at 0.1 times), so leaving them out would
 * under-count. We send no cache_control, so both should be 0 or null. Each is typed "number or null": absent or null
 * is 0; any other value that is not a usable count (tokenCount) is undefined, which marks the usage missing.
 */
const cacheCount = (value: unknown): number | undefined => (value === undefined || value === null ? 0 : tokenCount(value));

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
  readonly #apiKey: string;

  constructor(options: AnthropicOptions) {
    checkApiKey(options.apiKey, "ANTHROPIC_API_KEY");
    this.#model = options.model;
    this.#apiKey = options.apiKey;
    this.#client = new Anthropic({
      apiKey: options.apiKey,
      // The SDK reads ANTHROPIC_AUTH_TOKEN (an extra Authorization header) and ANTHROPIC_LOG (debug
      // logs hold the prompt) from process.env only when these options are undefined, so both are
      // explicit.
      authToken: null,
      logLevel: "off",
      // ANTHROPIC_CUSTOM_HEADERS has no such option: the SDK merges its "name: value" lines under these default headers
      // and sends them after its own auth headers (client.mjs:116-125, 837-838). So the key is set here too, and a null
      // authorization removes that header (internal/headers.mjs:96-99): the variable cannot replace the credentials.
      defaultHeaders: { "x-api-key": options.apiKey, authorization: null },
      // A followed redirect would carry every header, the key included, to another host. The SDK turns a 3xx into an
      // APIError with that status (client.mjs:583-615), which kindOf makes a bad request.
      fetchOptions: { redirect: "manual" },
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
    let response: Response;
    try {
      // asResponse() returns "as soon as the headers for a successful response are received and does not consume the
      // response body" (api/sdks/typescript.md); a 3xx, 4xx or 5xx is thrown as an APIError. So every failure below
      // this try came after a 2xx status line (P3-11 d).
      response = await this.#client.messages
        .create(
          {
            model: this.#model,
            max_tokens: req.maxOutputTokens,
            system: req.system,
            messages: [{ role: "user", content: req.user }],
            output_config: { format: { type: "json_schema", schema }, ...(effort === undefined ? {} : { effort }) },
          },
          { signal: req.signal },
        )
        .asResponse();
    } catch (error) {
      // Our abort while the SDK read an error body is a timeout, whatever the status (P3-11 a).
      const kind = req.signal.aborted ? "timeout" : kindOf(error);
      throw new ProviderError(kind, failureMessage(kind, error, this.#apiKey));
    }
    // Every field is read only after a type check: the body is never trusted.
    const data = await readJson(response);
    const content = own(data, "content");
    if (!Array.isArray(content)) {
      // Unread, not JSON or no content list: the provider accepted the call and may bill it (afterHeaders). Our abort
      // while the body was read is a timeout (P3-11 a).
      const kind = req.signal.aborted ? "timeout" : "unavailable";
      throw new ProviderError(kind, failureMessage(kind, undefined, this.#apiKey), { afterHeaders: true });
    }
    const text = own(content.find((block: unknown) => own(block, "type") === "text"), "text");
    const reason = own(data, "stop_reason");
    const stop = typeof reason === "string" && Object.hasOwn(STOP, reason) ? STOP[reason]! : "other";
    const model = own(data, "model");
    // A missing or unusable count is reported as 0 with usageMissing (P3-4a), never as a thrown error.
    const usage = own(data, "usage");
    const inputCounts = [tokenCount(own(usage, "input_tokens")), cacheCount(own(usage, "cache_creation_input_tokens")), cacheCount(own(usage, "cache_read_input_tokens"))];
    const outputTokens = tokenCount(own(usage, "output_tokens"));
    return {
      json: stop === "end" ? parseJson(text) : undefined,
      model: typeof model === "string" ? model : this.#model,
      usage: { inputTokens: inputCounts.reduce<number>((sum, count) => sum + (count ?? 0), 0), outputTokens: outputTokens ?? 0 },
      stop,
      ...(inputCounts.includes(undefined) || outputTokens === undefined ? { usageMissing: true as const } : {}),
    };
  }
}
