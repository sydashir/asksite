// The model-provider contract (design §6.2). Everything provider-specific lives behind it.

export interface ModelRequest {
  system: string;
  user: string; // Plan 3's prompt; owner text is quoted as data
  jsonSchema: Record<string, unknown>; // z.toJSONSchema(AiAnswer); refinements are checked afterwards by SiteDocument.
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface ModelResponse {
  json: unknown;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  stop: "end" | "max_tokens" | "refusal" | "other";
  /**
   * Set by an adapter when the provider sent no usage, or a count that is not a finite integer from 0 to
   * 10,000,000: each missing or unusable count is then 0 and a valid count is kept. Reporting only, never a cap.
   */
  usageMissing?: true;
}

export interface ModelProvider {
  readonly id: "anthropic" | "openai-compatible" | "fake";
  generate(req: ModelRequest): Promise<ModelResponse>;
}

/** "auth": the account or key needs a human: missing, wrong or revoked key, or billing. */
export type ProviderErrorKind = "timeout" | "rate_limited" | "unavailable" | "bad_request" | "auth";

// The fields are declared, not constructor parameter properties: the repo's tsconfig sets
// erasableSyntaxOnly, which rejects parameter properties. The public shape is the design's.
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  /**
   * Set by an adapter on an error raised after a 2xx status line arrived (P3-11 d): a body that could not be read,
   * or read to a malformed answer, or our abort while it was read. The provider accepted the call and may bill it,
   * but its usage is unknown, so generateDraft marks the attempt's usage missing. A 3xx, 4xx or 5xx status is a
   * refusal, treated as not billed, so its error never carries the flag, even when its body then fails [inferred, not
   * documented; Task 15 checks the billing of error statuses]. Otherwise the key is absent (`declare` emits no class
   * field, so it is never an own property holding undefined). Internal to this package.
   */
  declare readonly afterHeaders?: true;
  /**
   * Set by an adapter on an error raised when the call was made but no HTTP status line came back (P3-16 fix 5): the
   * fetch rejected (the Anthropic SDK's APIConnectionError) or our signal aborted before the headers. The provider may
   * have received the request and billed it, so generateDraft marks the attempt's usage missing. Failures before the
   * connection (DNS, a refused connection) are over-reported as unknown on purpose: that is conservative, and they cost
   * nothing. Otherwise the key is absent, as for afterHeaders. Internal to this package.
   */
  declare readonly noResponse?: true;
  /**
   * The provider's Retry-After on a 429 or 5xx, in whole seconds (a number of seconds only; a date is ignored), or absent.
   * generateDraft waits that long, capped at MAX_RETRY_AFTER_MS, instead of its fixed pause. Internal to this package.
   */
  declare readonly retryAfterSeconds?: number;
  constructor(kind: ProviderErrorKind, message: string, options: { afterHeaders?: true; noResponse?: true; retryAfterSeconds?: number } = {}) {
    super(message);
    this.kind = kind;
    this.name = "ProviderError";
    if (options.afterHeaders) this.afterHeaders = true;
    if (options.noResponse) this.noResponse = true;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export interface ModelPrice {
  inputMicrousdPerToken: number;
  outputMicrousdPerToken: number;
  source: string;
  checkedOn: string;
}

/** Errors worth another attempt after a pause (§6.3). */
export const TRANSIENT_KINDS: ReadonlySet<ProviderErrorKind> = new Set(["timeout", "rate_limited", "unavailable"]);
