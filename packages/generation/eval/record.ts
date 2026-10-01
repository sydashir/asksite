/** One live provider response, saved as a test fixture (Task 15) and replayed offline by recorded.test.ts. */
export interface RecordedResponse {
  provider: "anthropic" | "openai-compatible";
  modelId: string;
  status: number;
  body: unknown;
}

/** One request header as [name, value]. Kept in memory only, to check a fixture; never written anywhere. */
export type RequestHeader = readonly [name: string, value: string];

/**
 * Wraps fetch and keeps each response's status and body. The request is never kept in the sink (so never in a
 * fixture); its headers go to `seen`, in memory, for findRequestSecret.
 */
export function recordingFetch(inner: typeof fetch, sink: Array<{ status: number; body: unknown }>, seen: RequestHeader[] = []): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.forEach((value, name) => seen.push([name, value]));
    const response = await inner(input, init);
    const text = await response.clone().text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    sink.push({ status: response.status, body });
    return response;
  };
}

/** Header names that say nothing about a request's secrets; every other name must not appear in a fixture. */
const GENERIC_NAMES: ReadonlySet<string> = new Set(["accept", "content-type", "user-agent"]);
/** Names checked even when this run never saw them: the auth headers and the Anthropic version header. */
const ALWAYS_NAMES = ["authorization", "x-api-key", "proxy-authorization", "anthropic-version"] as const;
const AUTH_NAMES: ReadonlySet<string> = new Set(["authorization", "x-api-key", "proxy-authorization", "cookie"]);
const isAuthBearing = (name: string): boolean => AUTH_NAMES.has(name) || /key|token|secret|auth/.test(name);
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every key and string value of the JSON text, decoded and joined by newlines, so a header name that follows a line
 * break, CR or tab is seen after a real separator (the serialized text holds it as a backslash and a letter).
 */
function decodedStrings(text: string): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        out.push(key);
        walk(value);
      }
    }
  };
  try {
    walk(JSON.parse(text));
  } catch {
    // Not JSON: the raw text is checked alone.
  }
  return out.join("\n");
}

/** What findRequestSecret found: the rule (1 a secret value, 2 a header name) and a NAME, never the matched value. */
export interface SecretFinding {
  rule: 1 | 2;
  name: string;
}

/**
 * Looks for a request secret in the text a fixture would hold. Rule 1: the provider's API key value, or the value
 * (a Bearer token without its prefix too) of an auth-bearing request header: authorization, x-api-key,
 * proxy-authorization, cookie, or a name holding key, token, secret or auth. Rule 2: a request header name other
 * than accept, content-type and user-agent, as a whole token, in any letter case, in the raw text and in its decoded strings, so "authorization" does not match
 * "authorized". Returns null for a clean fixture. The result names a rule and a header; the value never leaves here.
 */
export function findRequestSecret(text: string, headers: readonly RequestHeader[], apiKey?: string): SecretFinding | null {
  if (apiKey !== undefined && apiKey !== "" && text.includes(apiKey)) return { rule: 1, name: "API key" };
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (!isAuthBearing(name)) continue;
    const bare = value.replace(/^Bearer\s+/i, "");
    if ((value !== "" && text.includes(value)) || (bare !== "" && text.includes(bare))) return { rule: 1, name };
  }
  const lower = `${text}\n${decodedStrings(text)}`.toLowerCase();
  const names = new Set<string>([...ALWAYS_NAMES, ...headers.map(([name]) => name.toLowerCase())]);
  for (const name of names) {
    if (GENERIC_NAMES.has(name)) continue;
    if (new RegExp(`(?<![a-z0-9_-])${escapeRegExp(name)}(?![a-z0-9_-])`).test(lower)) return { rule: 2, name };
  }
  return null;
}

/** A safe file name for a candidate label, e.g. "workers-ai/gpt-oss-120b" -> "workers-ai__gpt-oss-120b.json". */
export const fixtureName = (label: string): string => `${label.replace(/[^a-zA-Z0-9.-]+/g, "__")}.json`;
