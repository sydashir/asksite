import { ERROR_STATUS, toIssues, type ErrorBody, type ErrorCode, type Issue } from "@asksite/core";
import type { Context, MiddlewareHandler, NotFoundHandler, ErrorHandler } from "hono";
import { routePath } from "hono/route";
import type { z } from "zod";

// HTTP conventions shared by the app and admin Workers (design §4.1).

/** Largest JSON request body (§4.1). */
export const JSON_MAX_BYTES = 256 * 1024;

/** Most issues a 422 answer lists: the first ones, in order. A malformed body can make zod report one per element. */
export const MAX_ISSUES = 50;

/**
 * The shape every JSON body must keep, checked before its schema runs (P4-6). The largest valid body
 * of any schema read with readJson is far inside them (a draft: 30 items, 20 keys, 5 levels), so only
 * a malformed body is refused, before zod could build an issue for each of its thousands of elements.
 */
export const JSON_MAX_ITEMS = 64;
export const JSON_MAX_KEYS = 64;
export const JSON_MAX_DEPTH = 16;

/** Headers on every /api response. A route may set its own value first (the stored-version page does). */
export const API_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
} as const;

/** Production only: with includeSubDomains, HSTS from a localhost host would force https onto every local project (Plan 2 decision 8). */
const HSTS = "max-age=31536000; includeSubDomains";

/** The Worker's ENVIRONMENT variable, read without binding types (this package has none). */
const isProduction = (c: Context): boolean => (c.env as { ENVIRONMENT?: unknown } | undefined)?.ENVIRONMENT === "production";

type ErrorExtra = Omit<ErrorBody["error"], "code" | "message">;

/** Throw this from any handler; handleError turns it into an ErrorBody response. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly extra: ErrorExtra;

  constructor(code: ErrorCode, message: string, extra: ErrorExtra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

export function errorResponse(code: ErrorCode, message: string, extra: ErrorExtra = {}): Response {
  const body: ErrorBody = { error: { code, message, ...extra } };
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  if (extra.retryAfter !== undefined) headers.set("Retry-After", String(extra.retryAfter));
  return new Response(JSON.stringify(body), { status: ERROR_STATUS[code], headers });
}

type LogFields = Record<string, string | number>;

/** One structured log line. Logs hold route patterns, statuses and error codes only: never bodies, tokens, emails or IPs. */
export function logLine(fields: LogFields): void {
  console.log(JSON.stringify(fields));
}

// Each request writes exactly one line. apiHeaders writes it once the route has answered; the error
// handlers and requireOrigin only note their part of it here. Outside apiHeaders, the error handlers
// write the line themselves.
const notes = new WeakMap<Context, LogFields>();
const lineFollows = new WeakSet<Context>();

const note = (c: Context, fields: LogFields): void => {
  notes.set(c, { ...notes.get(c), ...fields });
};

/** Adds a route's own fields to the request's one line (why it refused, say). Never tokens, emails, IPs or bodies. */
export function noteLog(c: Context, fields: LogFields): void {
  note(c, fields);
}

/** The request's line: its route pattern (never the raw path), then what is known about it. */
const requestLine = (c: Context, fields: LogFields): void => logLine({ route: `${c.req.method} ${routePath(c)}`, ...fields, ...notes.get(c) });

function noteError(c: Context, code: ErrorCode, fields: LogFields = {}): void {
  note(c, { code, ...fields });
  if (!lineFollows.has(c)) requestLine(c, { status: ERROR_STATUS[code] });
}

export const handleError: ErrorHandler = (err, c) => {
  if (err instanceof ApiError) {
    noteError(c, err.code);
    return errorResponse(err.code, err.message, err.extra);
  }
  // The message may contain user data, so only the error's class name is logged.
  noteError(c, "internal", { error: err.name });
  return errorResponse("internal", "Something went wrong. Please try again.");
};

export const handleNotFound: NotFoundHandler = (c) => {
  noteError(c, "not_found");
  return errorResponse("not_found", "Not found");
};

export function apiHeaders(): MiddlewareHandler {
  return async (c, next) => {
    const started = Date.now();
    lineFollows.add(c);
    await next(); // hono answers an Error thrown by the route with handleError, inside next()
    // Should setting a header below throw, handleError answers that too, and then writes the line itself.
    lineFollows.delete(c);
    for (const [name, value] of Object.entries(API_HEADERS)) if (!c.res.headers.has(name)) c.res.headers.set(name, value);
    if (isProduction(c) && !c.res.headers.has("Strict-Transport-Security")) c.res.headers.set("Strict-Transport-Security", HSTS);
    requestLine(c, { status: c.res.status, ms: Date.now() - started });
  };
}

/**
 * CSRF defence: every request other than GET and HEAD must come from our own origin.
 * Fails closed: when the expected origin is not configured (missing or empty), every request is refused,
 * GET and HEAD included, and its log line carries event "origin_not_configured". The line's route tells
 * which variable is missing: /api/admin/* is the admin Worker's ADMIN_ORIGIN, any other /api/* the app's APP_ORIGIN.
 */
export function requireOrigin(expected: (c: Context) => string): MiddlewareHandler {
  return async (c, next) => {
    // Typed as a string, but a variable missing from the Worker's configuration is undefined at run time.
    const origin: string | undefined = expected(c);
    if (!origin) {
      note(c, { event: "origin_not_configured" });
      throw new ApiError("forbidden", "This request is not allowed");
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("Origin") !== origin) {
      throw new ApiError("forbidden", "This request is not allowed from another site");
    }
    await next();
  };
}

/** Reads the body, counting bytes as they arrive; a missing or false Content-Length cannot get past `max`. */
export async function readBytes(request: Request, max: number): Promise<Uint8Array> {
  return readUpTo(request, max, "That is too large to upload");
}

async function readUpTo(request: Request, max: number, tooLargeMessage: string): Promise<Uint8Array> {
  const tooLarge = () => new ApiError("payload_too_large", tooLargeMessage);
  if (Number(request.headers.get("Content-Length") ?? "0") > max) throw tooLarge();
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** The first place found (depth first) where `value` breaks a JSON_MAX_* shape limit; null when none. The root is level 1. */
function shapeIssue(value: unknown, path: Array<string | number> = [], level = 1): Issue | null {
  if (typeof value !== "object" || value === null) return null;
  const tooBig = (message: string): Issue => ({ path, code: "too_big", message });
  if (level > JSON_MAX_DEPTH) return tooBig(`The data is nested more than ${JSON_MAX_DEPTH} levels deep`);
  if (Array.isArray(value)) {
    if (value.length > JSON_MAX_ITEMS) return tooBig(`A list has more than ${JSON_MAX_ITEMS} items`);
    for (const [index, item] of value.entries()) {
      const issue = shapeIssue(item, [...path, index], level + 1);
      if (issue !== null) return issue;
    }
    return null;
  }
  const entries = Object.entries(value);
  if (entries.length > JSON_MAX_KEYS) return tooBig(`An object has more than ${JSON_MAX_KEYS} keys`);
  for (const [key, item] of entries) {
    const issue = shapeIssue(item, [...path, key], level + 1);
    if (issue !== null) return issue;
  }
  return null;
}

/**
 * Reads a JSON body and validates it. A body not declared as application/json is refused with 403,
 * like a cross-site form post (§4.1). A body outside the JSON_MAX_* shape is 422 validation_failed with
 * one issue naming the limit, before its schema runs; schema failures are 422 with the first MAX_ISSUES issues.
 */
export async function readJson<T>(c: Context, schema: z.ZodType<T>, max = JSON_MAX_BYTES): Promise<T> {
  if (!/^application\/json\s*(;|$)/i.test(c.req.header("Content-Type") ?? "")) {
    throw new ApiError("forbidden", "Expected a JSON request");
  }
  const bytes = await readUpTo(c.req.raw, max, "That is too large to save.");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError("bad_request", "The request body is not valid JSON");
  }
  const outOfShape = shapeIssue(value);
  if (outOfShape !== null) throw new ApiError("validation_failed", outOfShape.message, { issues: [outOfShape] });
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError("validation_failed", "Some fields are not valid", { issues: toIssues(parsed.error).slice(0, MAX_ISSUES) });
  }
  return parsed.data;
}

/** The Workers Rate Limiting binding's shape (only what we call). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export async function rateLimit(limiter: RateLimiter, key: string): Promise<void> {
  const { success } = await limiter.limit({ key });
  if (!success) throw new ApiError("rate_limited", "Too many requests. Please wait a minute and try again.", { retryAfter: 60 });
}

/** Seconds until the next 00:00 UTC (at least 1): the retryAfter for daily caps. */
export function secondsUntilUtcMidnight(now: number): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now) / 1000));
}

/** Headers for a stored page shown for review (§7.4): sandboxed, and framable only by our own origin. */
export function reviewPageHeaders(root: string): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src https://media.${root}; form-action 'none'; frame-ancestors 'self'`,
    "X-Frame-Options": "SAMEORIGIN",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex",
    "Cache-Control": "no-store",
  };
}
