import { ApiError, noteLog } from "@asksite/app-common";
import type { Context } from "hono";
import type { Siteverify } from "./deps.ts";
import type { AppEnv } from "./types.ts";

// Cloudflare Turnstile on POST /api/auth/login (A11), checked with siteverify
// (developers.cloudflare.com/turnstile/get-started/server-side-validation/): a token lasts 300 s and can
// be validated once, and a retry with the same idempotency_key is safe.

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The request header that carries the widget's token (the JSON body stays LoginBody). */
const TURNSTILE_HEADER = "x-turnstile-token";

const TIMEOUT_MS = 5_000;
const ATTEMPTS = 2; // the first call and exactly one retry
const MAX_TOKEN_LENGTH = 2_048; // siteverify's documented maximum

/** Why a request's token does not let it through; its log line names it. */
type Refusal = "missing" | "rejected" | "hostname" | "testing_key" | "unavailable";

interface SiteverifyResult {
  success: boolean;
  hostname: unknown;
  /**
   * `metadata.result_with_testing_key`: the real siteverify sets it for Cloudflare's test secret keys, whose
   * result names "example.com", never this app's host (measured 2026-09-26; not in the docs' field list).
   */
  testingKey: boolean;
}

/** Where the widget must have been solved, and whether a test key's result may stand in for that. */
interface Expected {
  hostname: string;
  testingKeyAllowed: boolean;
}

/** One siteverify call; null when it is worth one retry: a timeout, a network error, a non-2xx answer, an unreadable body or `internal-error`. */
async function siteverifyOnce(send: Siteverify, body: string): Promise<SiteverifyResult | null> {
  try {
    const res = await send(SITEVERIFY_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const result = (await res.json()) as { success?: unknown; hostname?: unknown; "error-codes"?: unknown; metadata?: { result_with_testing_key?: unknown } | null };
    if (typeof result.success !== "boolean") return null;
    if (Array.isArray(result["error-codes"]) && result["error-codes"].includes("internal-error")) return null;
    return { success: result.success, hostname: result.hostname, testingKey: result.metadata?.result_with_testing_key === true };
  } catch {
    return null;
  }
}

/**
 * D1 (moderator): a test key's result passes only where test keys belong, local development on a
 * *.localhost host; anywhere else it is refused even with success true, so a test secret that reaches
 * production can never let a request through. Any other result must name this app's host.
 */
function judge(result: SiteverifyResult, expected: Expected): Refusal | null {
  if (!result.success) return "rejected";
  if (result.testingKey) return expected.testingKeyAllowed ? null : "testing_key";
  return result.hostname === expected.hostname ? null : "hostname";
}

/** Null when siteverify accepts the token as `expected` says; otherwise why not. Fails closed: no answer is a refusal. */
async function turnstileRefusal(
  send: Siteverify,
  input: { secret: string; token: string | undefined; remoteIp: string | undefined; expected: Expected },
): Promise<Refusal | null> {
  if (input.token === undefined || input.token === "") return "missing";
  if (input.token.length > MAX_TOKEN_LENGTH) return "rejected";
  const body = JSON.stringify({
    secret: input.secret,
    response: input.token,
    ...(input.remoteIp === undefined ? {} : { remoteip: input.remoteIp }),
    idempotency_key: crypto.randomUUID(),
  });
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const result = await siteverifyOnce(send, body);
    if (result !== null) return judge(result, input.expected);
  }
  return "unavailable";
}

/** 403 forbidden unless the request carries a Turnstile token that siteverify accepts for this app's host name. */
export async function requireTurnstile(c: Context<AppEnv>, send: Siteverify): Promise<void> {
  const refusal = await turnstileRefusal(send, {
    secret: c.env.TURNSTILE_SECRET_KEY,
    token: c.req.header(TURNSTILE_HEADER),
    remoteIp: c.req.header("CF-Connecting-IP"),
    expected: {
      hostname: new URL(c.env.APP_ORIGIN).hostname,
      testingKeyAllowed: c.env.ENVIRONMENT === "development" && new URL(c.req.url).hostname.endsWith(".localhost"),
    },
  });
  if (refusal === null) return;
  noteLog(c, { turnstile: refusal });
  throw new ApiError("forbidden", "Please complete the security check and try again.");
}
