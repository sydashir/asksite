import { ApiError, noteLog } from "@asksite/app-common";
import type { Context } from "hono";
import type { Siteverify } from "./deps.ts";
import { isDocumentedTestSecret } from "./turnstile-secrets.ts";
import type { AppEnv } from "./types.ts";

// Cloudflare Turnstile on POST /api/auth/login (A11), checked with siteverify
// (developers.cloudflare.com/turnstile/get-started/server-side-validation/): a token lasts 300 s and can
// be validated once, and a retry with the same idempotency_key is safe.

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The request header that carries the widget's token (the JSON body stays LoginBody). */
const TURNSTILE_HEADER = "x-turnstile-token";

/** How long one siteverify call may take before it is abandoned (then retried once). */
export const SITEVERIFY_TIMEOUT_MS = 5_000;
const ATTEMPTS = 2; // the first call and exactly one retry
const MAX_TOKEN_LENGTH = 2_048; // siteverify's documented maximum

/** Why a request's token does not let it through; its log line names it. */
type Refusal = "missing" | "rejected" | "action" | "hostname" | "testing_key" | "unavailable";

/** The action the sign-in widget sets (data-action) and siteverify echoes back. */
export const LOGIN_ACTION = "login";

interface SiteverifyResult {
  success: boolean;
  action: unknown;
  hostname: unknown;
}

/** What this request must have been solved for, and whether the secret is a dummy one whose answer may stand in for that. */
interface Expected {
  hostname: string;
  /** The configured secret is one of the documented dummy secrets. */
  testSecret: boolean;
  /** Dummy secrets belong to local development on a *.localhost host only. */
  testSecretAllowed: boolean;
}

/** One siteverify call; null when it is worth one retry: a timeout, a network error, a non-2xx answer, an unreadable body or `internal-error`. */
async function siteverifyOnce(send: Siteverify, body: string, timeoutMs: number): Promise<SiteverifyResult | null> {
  try {
    const res = await send(SITEVERIFY_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const result = (await res.json()) as { success?: unknown; action?: unknown; hostname?: unknown; "error-codes"?: unknown };
    if (typeof result.success !== "boolean") return null;
    if (Array.isArray(result["error-codes"]) && result["error-codes"].includes("internal-error")) return null;
    return { success: result.success, action: result.action, hostname: result.hostname };
  } catch {
    return null;
  }
}

/**
 * D1 (moderator): a dummy secret's result passes only where dummy secrets belong, local development on a
 * *.localhost host; anywhere else it is refused even with success true, so a test secret that reaches
 * production can never let a request through. There success true is enough: the real service answers a dummy
 * secret with no action and the host name example.com (measured 2026-09-30, unlike its docs page), so neither
 * is checked (P4-22 M1 re-ruling). Any other secret needs action "login" and this app's host name; an
 * answer with no host name is refused. Docs: "Check if action / hostname matches expected value".
 */
function judge(result: SiteverifyResult, expected: Expected): Refusal | null {
  if (!result.success) return "rejected";
  if (expected.testSecret) {
    if (!expected.testSecretAllowed) return "testing_key";
    return null;
  }
  if (result.action !== LOGIN_ACTION) return "action";
  return result.hostname === expected.hostname ? null : "hostname";
}

/** Null when siteverify accepts the token as `expected` says; otherwise why not. Fails closed: no answer is a refusal. */
async function turnstileRefusal(
  send: Siteverify,
  input: { secret: string; token: string | undefined; remoteIp: string | undefined; expected: Expected; timeoutMs: number },
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
    const result = await siteverifyOnce(send, body, input.timeoutMs);
    if (result !== null) return judge(result, input.expected);
  }
  return "unavailable";
}

/**
 * 403 forbidden unless the request carries a Turnstile token that siteverify accepts for this app's host name and the login action.
 * `timeoutMs` is only ever shortened by the test Worker, so a test of a siteverify that never answers stays fast.
 */
export async function requireTurnstile(c: Context<AppEnv>, send: Siteverify, timeoutMs = SITEVERIFY_TIMEOUT_MS): Promise<void> {
  const refusal = await turnstileRefusal(send, {
    secret: c.env.TURNSTILE_SECRET_KEY,
    token: c.req.header(TURNSTILE_HEADER),
    remoteIp: c.req.header("CF-Connecting-IP"),
    expected: {
      hostname: new URL(c.env.APP_ORIGIN).hostname,
      testSecret: isDocumentedTestSecret(c.env.TURNSTILE_SECRET_KEY),
      testSecretAllowed: c.env.ENVIRONMENT === "development" && new URL(c.req.url).hostname.endsWith(".localhost"),
    },
    timeoutMs,
  });
  if (refusal === null) return;
  noteLog(c, { turnstile: refusal });
  throw new ApiError("forbidden", "Please complete the security check and try again.");
}
