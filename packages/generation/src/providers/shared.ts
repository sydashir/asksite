import { ProviderError, type ProviderErrorKind } from "../provider.ts";

// Rules both HTTP adapters (anthropic.ts, openai-compatible.ts) share, kept in one place so they cannot drift apart (P3-11).

/**
 * The kind for a 4xx or 5xx status, one rule for both adapters (P3-11 e): 401, 402 and 403 need a human, like a bad
 * key; 408 and 504 are timeouts; 409 is unavailable and 429 a rate limit, both worth another attempt; any other 4xx
 * is a bad request, never retried; any other status is unavailable. Before this, each adapter makes a 3xx (a redirect
 * it did not follow) a bad request and checks its own documented special cases.
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

/**
 * The characters a key may hold: printable ASCII and U+00A0 to U+00FF, the characters an HTTP header carries as
 * typed, control characters excluded. The Fetch Standard's Headers refuse NUL, CR and LF (a header value) and anything
 * above U+00FF (ByteString), and strip leading and trailing whitespace; RFC 9110 and Node's HTTP stack also refuse the
 * other C0 controls and DEL. A tab or a C1 control could be sent, but no key holds one.
 */
const HEADER_TEXT = /^[\x20-\x7E\xA0-\xFF]*$/;

/**
 * Throws ProviderError("auth") at setup, before any request (P3-11 k), for a key that is blank or holds a character
 * outside HEADER_TEXT: no request can carry it as typed, so it needs a human, like a wrong key. `name` is the key's
 * variable; the message never holds the key.
 */
export function checkApiKey(key: string, name: string): void {
  if (key.trim() === "" || !HEADER_TEXT.test(key)) throw new ProviderError("auth", `${name} is blank or holds a character an HTTP header cannot carry`);
}

/** The shortest run of characters a provider token may not share with the key (P3-11 t). */
const KEY_FRAGMENT = 8;

/**
 * Whether a provider token shares a run of KEY_FRAGMENT or more characters with the key, ignoring case (P3-11 t): such
 * a token is left out of an error message. Any shared run that long holds a shared run of exactly KEY_FRAGMENT, so the
 * key's KEY_FRAGMENT-long windows are enough. A key shorter than that is matched whole.
 */
export function sharesKeyFragment(token: string, key: string): boolean {
  const text = token.toLowerCase();
  const secret = key.toLowerCase();
  if (secret.length < KEY_FRAGMENT) return text.includes(secret);
  for (let start = 0; start + KEY_FRAGMENT <= secret.length; start++) {
    if (text.includes(secret.slice(start, start + KEY_FRAGMENT))) return true;
  }
  return false;
}
