import { isSafeUrl } from "@asksite/site-schema";
import { modelSettings } from "../models.ts";
import { ProviderError, type ModelProvider, type ModelRequest, type ModelResponse, type ProviderErrorKind } from "../provider.ts";
import { dropNulls, toWireSchema } from "../wire-schema.ts";
import { checkApiKey, sharesKeyFragment, statusKind, tokenCount } from "./shared.ts";

export interface OpenAICompatibleOptions {
  /** e.g. https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1 or https://router.huggingface.co/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
}

const STOP: Record<string, ModelResponse["stop"]> = { stop: "end", length: "max_tokens", content_filter: "refusal" };

/**
 * Cloudflare's JSON Mode page: when the model cannot meet the schema, "an error `JSON Mode couldn't be
 * met` is returned and must be handled". Its status and body shape are not documented, so it counts
 * only where the status alone would give a bad request (P3-11 r): in the body text of a 4xx the status
 * rule makes a bad request, and in the fields hosts use for errors (a string `error`, `error.message`,
 * `errors[].message`) of such a 4xx or of a 2xx; never in a 2xx answer's model text, which may quote it.
 * A redirect, auth, a rate limit, a timeout or an outage keeps its kind. Such an answer has no JSON:
 * generateDraft sends repair feedback instead of stopping on a bad request.
 */
const JSON_MODE_UNMET = "JSON Mode couldn't be met";

/**
 * Groq's monthly spend cap (console.groq.com/docs/spend-limits): calls "will return a 400 with code
 * `blocked_api_access`". The page shows no body; error.code is inferred from Groq's other documented
 * error bodies, so the code anywhere else stays a bad request, which is never retried either.
 */
const GROQ_SPEND_CAP = "blocked_api_access";

/**
 * console.groq.com/docs/errors.md: "498 Custom: Flex Tier Capacity Exceeded: This is a custom status code we use and
 * will return in the event that the flex tier is at capacity and the request won't be processed. You can try again
 * later." We never send service_tier, whose Chat Completions default is on_demand (Groq's API reference).
 */
const GROQ_FLEX_CAPACITY = 498;

/** A provider error type or code a message may carry: a short plain token, never provider text. */
const SAFE_ERROR_TOKEN = /^[a-z0-9_.-]{1,64}$/;

/** An own property of a parsed JSON value, or undefined: a body's shape is never trusted. */
const own = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;

/** The texts in a parsed body's error fields: a string `error`, `error.message` and each `errors[].message`. */
function errorTexts(data: unknown): unknown[] {
  const error = own(data, "error");
  const errors = own(data, "errors");
  return [error, own(error, "message"), ...(Array.isArray(errors) ? errors.map((entry) => own(entry, "message")) : [])];
}

/** Whether an answer says JSON Mode could not be met (see JSON_MODE_UNMET for where it counts). */
function jsonModeUnmet(ok: boolean, status: number, text: string, data: unknown): boolean {
  const inErrorFields = errorTexts(data).some((field) => typeof field === "string" && field.includes(JSON_MODE_UNMET));
  if (ok) return inErrorFields;
  return status >= 400 && kindOf(status, own(data, "error")) === "bad_request" && (inErrorFields || text.includes(JSON_MODE_UNMET));
}

/**
 * The shared status rule (statusKind), after this host's own cases: Groq's spend cap needs a human, like a bad key,
 * and its flex-tier 498 is a rate limit. `error` is the body's `error` field, whatever its shape.
 */
function kindOf(status: number, error: unknown): ProviderErrorKind {
  if (status < 400) return "bad_request"; // a redirect we refused to follow: the base URL is wrong
  if (status === 400 && own(error, "code") === GROQ_SPEND_CAP) return "auth";
  if (status === GROQ_FLEX_CAPACITY) return "rate_limited";
  return statusKind(status);
}

/** The parsed body, or undefined when it is not JSON (JSON.parse never returns undefined). */
const parseBody = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const parseJson = (text: unknown): unknown => {
  if (typeof text !== "string") return undefined;
  try {
    return dropNulls(JSON.parse(text));
  } catch {
    return undefined;
  }
};

/**
 * The error for a 2xx whose body could not be read or holds no usable answer (P3-11 d): the provider accepted the
 * call and may bill it, so the error carries afterHeaders. Our abort while the body was read is a timeout (P3-11 a).
 */
const failedAnswer = (signal: AbortSignal, message: string): ProviderError =>
  new ProviderError(signal.aborted ? "timeout" : "unavailable", message, { afterHeaders: true });

/** The body as text, or "" when it cannot be read (a dropped connection, or our abort mid-body). */
async function bodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * Any "OpenAI-compatible" Chat Completions API: Cloudflare Workers AI, Groq, Together, OpenRouter,
 * the Hugging Face router, or a self-hosted vLLM or llama.cpp server. Request: POST
 * <base>/chat/completions, Bearer key, response_format json_schema with strict: true (Groq's
 * strict mode needs every property required and additionalProperties false, which toWireSchema
 * gives). Whether each host enforces the schema is measured by the eval (Task 15). The model's
 * extra fields go first, so they can never replace ours. Redirects are not followed: one would
 * carry the Bearer key to another host (workerd accepts only "follow" and "manual"). The body is read
 * as text once; every field is read only after a type check, as hosts answer errors in different
 * shapes (an `error` object or string, or Cloudflare's `errors` list).
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai-compatible";
  readonly #url: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAICompatibleOptions) {
    checkApiKey(options.apiKey, "OPENAI_COMPAT_API_KEY");
    if (!isSafeUrl(options.baseUrl, ["https:"])) throw new ProviderError("bad_request", "OPENAI_COMPAT_BASE_URL must be an absolute https:// URL");
    this.#url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.#apiKey = options.apiKey;
    this.#model = options.model;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    // Our own code runs before the try, so an error in it propagates instead of becoming a ProviderError.
    const body = JSON.stringify({
      ...modelSettings("openai-compatible", this.#model)?.extraBody,
      model: this.#model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      max_tokens: req.maxOutputTokens,
      response_format: { type: "json_schema", json_schema: { name: "site_draft", strict: true, schema: toWireSchema(req.jsonSchema) } },
    });
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
        body,
        redirect: "manual",
        signal: req.signal,
      });
    } catch {
      throw new ProviderError(req.signal.aborted ? "timeout" : "unavailable", "OpenAI-compatible request failed");
    }
    const text = await bodyText(response);
    const data = parseBody(text);
    if (jsonModeUnmet(response.ok, response.status, text, data)) return this.#answer(data, undefined, "end");
    if (!response.ok) {
      const error = own(data, "error");
      // Our abort while the body was read is a timeout, whatever the status (P3-11 a).
      throw this.#failure(req.signal.aborted ? "timeout" : kindOf(response.status, error), response.status, error);
    }
    if (data === undefined) throw failedAnswer(req.signal, "OpenAI-compatible response was not JSON");
    const choices = own(data, "choices");
    const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
    if (typeof choice !== "object" || choice === null) throw failedAnswer(req.signal, "OpenAI-compatible response had no choices");
    const reason = own(choice, "finish_reason");
    const stop = typeof reason === "string" && Object.hasOwn(STOP, reason) ? STOP[reason]! : "other";
    return this.#answer(data, stop === "end" ? parseJson(own(own(choice, "message"), "content")) : undefined, stop);
  }

  /** The answer with the body's model and usage: a missing or unusable count is 0 with usageMissing (P3-4a). */
  #answer(data: unknown, json: unknown, stop: ModelResponse["stop"]): ModelResponse {
    const model = own(data, "model");
    const usage = own(data, "usage");
    const inputTokens = tokenCount(own(usage, "prompt_tokens"));
    const outputTokens = tokenCount(own(usage, "completion_tokens"));
    return {
      json,
      model: typeof model === "string" ? model : this.#model,
      usage: { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 },
      stop,
      ...(inputTokens === undefined || outputTokens === undefined ? { usageMissing: true as const } : {}),
    };
  }

  /**
   * The kind, the HTTP status and the provider's own error type and code when each is a plain token
   * (OpenAI-style bodies: error.type, error.code): never its text, the key or headers. A token that shares
   * a fragment with the key (sharesKeyFragment) is left out too.
   */
  #failure(kind: ProviderErrorKind, status: number, error: unknown): ProviderError {
    const tokens = new Set<string>();
    for (const token of [own(error, "type"), own(error, "code")]) {
      if (typeof token === "string" && SAFE_ERROR_TOKEN.test(token) && !sharesKeyFragment(token, this.#apiKey)) tokens.add(token);
    }
    return new ProviderError(kind, `OpenAI-compatible request failed (${[kind, `HTTP ${status}`, ...tokens].join(", ")})`);
  }
}
