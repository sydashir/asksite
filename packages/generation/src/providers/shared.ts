import type { ProviderErrorKind } from "../provider.ts";

// Rules both HTTP adapters (anthropic.ts, openai-compatible.ts) share, kept in one place so they cannot drift apart (P3-11).

/**
 * The kind for a 4xx or 5xx status, one rule for both adapters (P3-11 e): 401, 402 and 403 need a human, like a bad
 * key; 408 and 504 are timeouts; 409 is unavailable and 429 a rate limit, both worth another attempt; any other 4xx
 * is a bad request, never retried; any other status is unavailable. Each adapter checks its own documented special
 * cases, and a redirect, before this.
 */
export function statusKind(status: number): ProviderErrorKind {
  if (status === 401 || status === 402 || status === 403) return "auth";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500 && status !== 409) return "bad_request";
  return "unavailable";
}

/** The largest token count we accept from a provider; any real call is far below it. */
const MAX_TOKEN_COUNT = 10_000_000;

/**
 * A token count as reported, or undefined when it is missing or not a finite integer from 0 to MAX_TOKEN_COUNT
 * (P3-11 l): the adapter then counts it as 0 and marks the usage missing.
 */
export const tokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_TOKEN_COUNT ? value : undefined;
