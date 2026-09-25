import { isSafeUrl } from "@asksite/site-schema";
import { modelSettings } from "../models.ts";
import { ProviderError, type ModelProvider, type ModelRequest, type ModelResponse, type ProviderErrorKind } from "../provider.ts";
import { dropNulls, toWireSchema } from "../wire-schema.ts";

export interface OpenAICompatibleOptions {
  /** e.g. https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1 or https://router.huggingface.co/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
}

interface ChatCompletion {
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

const STOP: Record<string, ModelResponse["stop"]> = { stop: "end", length: "max_tokens", content_filter: "refusal" };

function kindOfStatus(status: number): ProviderErrorKind {
  if (status < 400) return "bad_request"; // a redirect we refused to follow: the base URL is wrong
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 404 || status === 413 || status === 422) return "bad_request";
  return "unavailable";
}

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0);

const parseJson = (text: unknown): unknown => {
  if (typeof text !== "string") return undefined;
  try {
    return dropNulls(JSON.parse(text));
  } catch {
    return undefined;
  }
};

/**
 * Any "OpenAI-compatible" Chat Completions API: Cloudflare Workers AI, Groq, Together, OpenRouter,
 * the Hugging Face router, or a self-hosted vLLM or llama.cpp server. Request: POST
 * <base>/chat/completions, Bearer key, response_format json_schema with strict: true (Groq's
 * strict mode needs every property required and additionalProperties false, which toWireSchema
 * gives). Whether each host enforces the schema is measured by the eval (Task 15). The model's
 * extra fields go first, so they can never replace ours. Redirects are not followed: one would
 * carry the Bearer key to another host (workerd accepts only "follow" and "manual").
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
    const body = {
      ...modelSettings("openai-compatible", this.#model)?.extraBody,
      model: this.#model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      max_tokens: req.maxOutputTokens,
      response_format: { type: "json_schema", json_schema: { name: "site_draft", strict: true, schema: toWireSchema(req.jsonSchema) } },
    };
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: req.signal,
      });
    } catch {
      throw new ProviderError(req.signal.aborted ? "timeout" : "unavailable", "OpenAI-compatible request failed");
    }
    if (!response.ok) {
      const kind = kindOfStatus(response.status);
      throw new ProviderError(kind, `OpenAI-compatible request failed (${kind}, HTTP ${response.status})`);
    }
    let data: ChatCompletion;
    try {
      data = (await response.json()) as ChatCompletion;
    } catch {
      throw new ProviderError(req.signal.aborted ? "timeout" : "unavailable", "OpenAI-compatible response was not JSON");
    }
    const choice = data.choices?.[0];
    if (choice === undefined) throw new ProviderError("unavailable", "OpenAI-compatible response had no choices");
    const reason = typeof choice.finish_reason === "string" ? choice.finish_reason : "";
    const stop = Object.hasOwn(STOP, reason) ? STOP[reason]! : "other";
    return {
      json: stop === "end" ? parseJson(choice.message?.content) : undefined,
      model: typeof data.model === "string" ? data.model : this.#model,
      usage: { inputTokens: count(data.usage?.prompt_tokens), outputTokens: count(data.usage?.completion_tokens) },
      stop,
    };
  }
}
