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
type Refusal = "missing" | "rejected" | "hostname" | "unavailable";

interface SiteverifyResult {
  success: boolean;
  hostname?: unknown;
}

/** One siteverify call; null when it is worth one retry: a timeout, a network error, a non-2xx answer, an unreadable body or `internal-error`. */
async function siteverifyOnce(send: Siteverify, body: string): Promise<SiteverifyResult | null> {
  try {
    const res = await send(SITEVERIFY_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const result = (await res.json()) as { success?: unknown; hostname?: unknown; "error-codes"?: unknown };
    if (typeof result.success !== "boolean") return null;
    if (Array.isArray(result["error-codes"]) && result["error-codes"].includes("internal-error")) return null;
    return { success: result.success, hostname: result.hostname };
  } catch {
    return null;
  }
}

/** Null when siteverify accepts the token for `hostname`; otherwise why not. Fails closed: no answer is a refusal. */
async function turnstileRefusal(
  send: Siteverify,
  input: { secret: string; token: string | undefined; remoteIp: string | undefined; hostname: string },
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
    if (result === null) continue;
    if (!result.success) return "rejected";
    return result.hostname === input.hostname ? null : "hostname";
  }
  return "unavailable";
}

/** 403 forbidden unless the request carries a Turnstile token that siteverify accepts for this app's host name. */
export async function requireTurnstile(c: Context<AppEnv>, send: Siteverify): Promise<void> {
  const refusal = await turnstileRefusal(send, {
    secret: c.env.TURNSTILE_SECRET_KEY,
    token: c.req.header(TURNSTILE_HEADER),
    remoteIp: c.req.header("CF-Connecting-IP"),
    hostname: new URL(c.env.APP_ORIGIN).hostname,
  });
  if (refusal === null) return;
  noteLog(c, { turnstile: refusal });
  throw new ApiError("forbidden", "Please complete the security check and try again.");
}
