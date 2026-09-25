import { isSafeUrl } from "@asksite/site-schema";
import { modelSettings } from "../models.ts";
import { ProviderError, type ModelProvider, type ModelRequest, type ModelResponse, type ProviderErrorKind } from "../provider.ts";
import { dropNulls, toWireSchema } from "../wire-schema.ts";
import { statusKind } from "./shared.ts";

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
 * met` is returned and must be handled". Its status and body shape are not documented, so it counts in
 * the body text of a failed (non-2xx) answer, and in the fields hosts use for errors (a string `error`,
 * `error.message`, `errors[].message`) whatever the status; never in a 2xx answer's model text, which
 * may quote it. Such an answer has no JSON: generateDraft sends repair feedback instead of stopping on a
 * bad request.
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
const jsonModeUnmet = (ok: boolean, text: string, data: unknown): boolean =>
  (!ok && text.includes(JSON_MODE_UNMET)) || errorTexts(data).some((field) => typeof field === "string" && field.includes(JSON_MODE_UNMET));

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

/** A token count as reported, or undefined when it is missing or not a finite number of at least 0. */
const tokenCount = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

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
    if (jsonModeUnmet(response.ok, text, data)) return this.#answer(data, undefined, "end");
    if (!response.ok) throw this.#failure(response.status, own(data, "error"));
    if (data === undefined) throw new ProviderError(req.signal.aborted ? "timeout" : "unavailable", "OpenAI-compatible response was not JSON");
    const choices = own(data, "choices");
    const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
    if (typeof choice !== "object" || choice === null) throw new ProviderError("unavailable", "OpenAI-compatible response had no choices");
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
   * (OpenAI-style bodies: error.type, error.code): never its text, the key or headers. A token holding
   * the key is left out too.
   */
  #failure(status: number, error: unknown): ProviderError {
    const kind = kindOf(status, error);
    const tokens = new Set<string>();
    for (const token of [own(error, "type"), own(error, "code")]) {
      if (typeof token === "string" && SAFE_ERROR_TOKEN.test(token) && !token.includes(this.#apiKey)) tokens.add(token);
    }
    return new ProviderError(kind, `OpenAI-compatible request failed (${[kind, `HTTP ${status}`, ...tokens].join(", ")})`);
  }
}
