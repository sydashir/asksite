// The model-provider contract (design §6.2). Everything provider-specific lives behind it.

export interface ModelRequest {
  system: string;
  user: string; // Plan 3's prompt; owner text is quoted as data
  jsonSchema: Record<string, unknown>; // z.toJSONSchema(AiDraft); refinements are checked afterwards by SiteDocument.
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface ModelResponse {
  json: unknown;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  stop: "end" | "max_tokens" | "refusal" | "other";
  /** Set by an adapter only when the provider sent no usage; usage is then 0/0; reporting only, never a cap. */
  usageMissing?: true;
}

export interface ModelProvider {
  readonly id: "anthropic" | "openai-compatible" | "fake";
  generate(req: ModelRequest): Promise<ModelResponse>;
}

export type ProviderErrorKind = "timeout" | "rate_limited" | "unavailable" | "bad_request" | "auth";

// The field is declared, not a constructor parameter property: the repo's tsconfig sets
// erasableSyntaxOnly, which rejects parameter properties. The public shape is the design's.
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  constructor(kind: ProviderErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "ProviderError";
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
