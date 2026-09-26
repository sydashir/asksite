import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../src/provider.ts";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { AI_DRAFT_JSON_SCHEMA, toWireSchema } from "../src/wire-schema.ts";
import { abortedSignal, fakeFetch } from "./support/http.ts";

// No test in this file may reach the network, even when a mutant drops the fetch we inject: the SDK takes the global
// fetch when it is built without one (client.mjs:113), and this global fails loudly instead. No test may even try.
const globalFetchCalls: string[] = [];
beforeEach(() => {
  globalFetchCalls.length = 0;
  vi.stubGlobal("fetch", async (input: unknown) => {
    globalFetchCalls.push(String(input));
    throw new TypeError("the global fetch must not be used");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(globalFetchCalls).toEqual([]);
});

// Response shape from the official structured-outputs page (JSON in content[].text, checked
// 2026-09-24). Task 15 adds a recorded live response (recorded.test.ts).
const message = (text: string, stop_reason = "end_turn") => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text }],
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 3200, output_tokens: 1400 },
});

const request = (signal = new AbortController().signal) => ({ system: "SYS", user: "USER", jsonSchema: AI_DRAFT_JSON_SCHEMA, maxOutputTokens: 8192, signal });

/** A fetch that answers every call with this status and this exact body text. */
const rawFetch = (status: number, text: string) => async (): Promise<Response> => new Response(text, { status, headers: { "content-type": "application/json" } });

// The tier spend-cap body, as documented on platform.claude.com api/rate-limits.md ("Reaching your spend cap").
const SPEND_CAP = "enforced_spend_limit_reached";
const spendCapBody = (details: unknown) => ({ type: "error", error: { type: "rate_limit_error", message: "You have reached your API usage limits", details }, request_id: "req_1" });

/** Runs fn with one environment variable set, then restores it (deleting it if it was unset). */
async function withEnv(name: string, value: string, fn: () => Promise<void>): Promise<void> {
  const saved = process.env[name];
  process.env[name] = value;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

describe("AnthropicProvider", () => {
  it("sends one Messages API request with structured output in output_config.format", async () => {
    const http = fakeFetch([{ status: 200, body: message('{"a":1}') }]);
    await new AnthropicProvider({ apiKey: "sk-test", model: "claude-opus-5-5", fetch: http.fetch }).generate(request());
    expect(http.calls).toHaveLength(1);
    const { url, headers, body } = http.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers.get("x-api-key")).toBe("sk-test");
    expect(body).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 8192,
      system: "SYS",
      messages: [{ role: "user", content: "USER" }],
      output_config: { format: { type: "json_schema", schema: toWireSchema(AI_DRAFT_JSON_SCHEMA) }, effort: "low" },
    });
  });

  it("sends no effort for a model that rejects it", async () => {
    const http = fakeFetch([{ status: 200, body: { ...message("{}"), model: "claude-haiku-4-5" } }]);
    await new AnthropicProvider({ apiKey: "k", model: "claude-haiku-4-5", fetch: http.fetch }).generate(request());
    expect(http.calls[0]!.body.output_config).toEqual({ format: { type: "json_schema", schema: toWireSchema(AI_DRAFT_JSON_SCHEMA) } });
  });

  it("returns the parsed JSON text with nulls removed, the model, usage and stop reason", async () => {
    const http = fakeFetch([{ status: 200, body: message('{"copy":{"about":null,"x":"y"}}') }]);
    const res = await new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch }).generate(request());
    expect(res).toEqual({ json: { copy: { x: "y" } }, model: "claude-opus-5-5", usage: { inputTokens: 3200, outputTokens: 1400 }, stop: "end" });
  });

  it.each([
    ["max_tokens", "max_tokens"],
    ["refusal", "refusal"],
    ["pause_turn", "other"],
  ])("maps stop_reason %s to %s", async (reason, stop) => {
    const http = fakeFetch([{ status: 200, body: message("{", reason) }]);
    const res = await new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch }).generate(request());
    expect(res.stop).toBe(stop);
    expect(res.json).toBeUndefined();
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limited"],
    [400, "bad_request"],
    [404, "bad_request"],
    [500, "unavailable"],
    [529, "unavailable"],
    [402, "auth"],
    [409, "unavailable"],
    [504, "timeout"],
    [413, "bad_request"],
    [422, "bad_request"],
  ])("maps HTTP %i to a %s ProviderError, with no SDK retry", async (status, kind) => {
    const http = fakeFetch([{ status, body: { type: "error", error: { type: "x", message: "m" } } }, { status: 200, body: message("{}") }]);
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch });
    await expect(provider.generate(request())).rejects.toMatchObject({ name: "ProviderError", kind });
    expect(http.calls).toHaveLength(1);
  });

  it("maps the tier spend cap (a 429 with details.error_code enforced_spend_limit_reached) to auth, naming the code", async () => {
    const http = fakeFetch([{ status: 429, body: spendCapBody({ error_code: SPEND_CAP }) }, { status: 200, body: message("{}") }]);
    const provider = new AnthropicProvider({ apiKey: "sk-secret-429", model: "claude-opus-5-5", fetch: http.fetch });
    const error: unknown = await provider.generate(request()).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ProviderError", kind: "auth", message: `Anthropic request failed (auth, HTTP 429, rate_limit_error, ${SPEND_CAP})` });
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    ["no details (a plain rate limit)", { type: "error", error: { type: "rate_limit_error", message: "m" } }],
    ["another error_code", spendCapBody({ error_code: "some_other_code" })],
    ["an error_code that only starts with the spend-cap code", spendCapBody({ error_code: `${SPEND_CAP}_x` })],
  ])("keeps a 429 with %s rate_limited, naming no code", async (_label, body) => {
    const http = fakeFetch([{ status: 429, body }]);
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch });
    await expect(provider.generate(request())).rejects.toMatchObject({ kind: "rate_limited", message: "Anthropic request failed (rate_limited, HTTP 429, rate_limit_error)" });
  });

  it.each([
    ["a body that is not JSON", SPEND_CAP],
    ["a JSON string body", JSON.stringify(SPEND_CAP)],
    ["a JSON null body", "null"],
    ["an array body", JSON.stringify([spendCapBody({ error_code: SPEND_CAP })])],
    ["error as a string", JSON.stringify({ type: "error", error: SPEND_CAP })],
    ["details as a string", JSON.stringify(spendCapBody(SPEND_CAP))],
    ["details null", JSON.stringify(spendCapBody(null))],
    ["details as an array", JSON.stringify(spendCapBody([{ error_code: SPEND_CAP }]))],
    ["error_code in an array", JSON.stringify(spendCapBody({ error_code: [SPEND_CAP] }))],
    ["error_code at the error level", JSON.stringify({ type: "error", error: { type: "rate_limit_error", error_code: SPEND_CAP } })],
    ["details at the top level", JSON.stringify({ type: "error", error: { type: "rate_limit_error" }, details: { error_code: SPEND_CAP } })],
  ])("keeps a 429 with %s rate_limited", async (_label, text) => {
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: rawFetch(429, text) });
    await expect(provider.generate(request())).rejects.toMatchObject({ name: "ProviderError", kind: "rate_limited" });
  });

  it("names the spend-cap code only on a 429", async () => {
    const body = { type: "error", error: { type: "invalid_request_error", message: "m", details: { error_code: SPEND_CAP } } };
    const http = fakeFetch([{ status: 400, body }]);
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch });
    await expect(provider.generate(request())).rejects.toMatchObject({ kind: "bad_request", message: "Anthropic request failed (bad_request, HTTP 400, invalid_request_error)" });
  });

  it("maps a network failure to unavailable", async () => {
    const http = fakeFetch([new TypeError("fetch failed")]);
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch });
    await expect(provider.generate(request())).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("maps our 90 s abort to timeout", async () => {
    const http = fakeFetch([{ status: 200, body: message("{}") }]);
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch });
    await expect(provider.generate(request(abortedSignal()))).rejects.toMatchObject({ kind: "timeout" });
  });

  it("gives the SDK a 90 s timeout (sent as x-stainless-timeout)", async () => {
    const http = fakeFetch([{ status: 200, body: message("{}") }]);
    await new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch }).generate(request());
    expect(http.calls[0]!.headers.get("x-stainless-timeout")).toBe("90");
  });

  // Each of these fetch failures is what the SDK turns into APIConnectionTimeoutError (client.mjs
  // makeRequest: an AbortError, or "timed out"/"timeout" in the error or its cause).
  it.each([
    ["the SDK's own timer aborting the fetch", new DOMException("This operation was aborted", "AbortError")],
    ["a fetch TimeoutError", new DOMException("The operation timed out.", "TimeoutError")],
    ["an undici connect timeout", new TypeError("fetch failed", { cause: new Error("Connect Timeout Error (attempted address: api.anthropic.com:443, timeout: 10000ms)") })],
  ])("maps %s (the SDK's APIConnectionTimeoutError) to timeout", async (_label, failure) => {
    const http = fakeFetch([failure]);
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch });
    await expect(provider.generate(request())).rejects.toMatchObject({ name: "ProviderError", kind: "timeout", message: "Anthropic request failed (timeout)" });
    expect(http.calls).toHaveLength(1);
  });

  it("maps an error from the SDK that is not an APIError (a 200 whose JSON body does not parse) to unavailable", async () => {
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: rawFetch(200, '{"id":') });
    await expect(provider.generate(request())).rejects.toMatchObject({ name: "ProviderError", kind: "unavailable", message: "Anthropic request failed (unavailable)" });
  });

  it("returns no JSON, without throwing, when an end_turn answer is not valid JSON", async () => {
    const http = fakeFetch([{ status: 200, body: message('{"copy":') }]);
    const res = await new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch }).generate(request());
    expect(res).toEqual({ json: undefined, model: "claude-opus-5-5", usage: { inputTokens: 3200, outputTokens: 1400 }, stop: "end" });
  });

  it("lets an error from our own schema conversion propagate as it is, not as a ProviderError", async () => {
    const jsonSchema = { type: "string", format: "date" };
    expect(() => toWireSchema(jsonSchema)).toThrow('toWireSchema: unsupported JSON schema keyword "format"');
    const http = fakeFetch([{ status: 200, body: message("{}") }]);
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch });
    const error: unknown = await provider.generate({ ...request(), jsonSchema }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ProviderError);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('toWireSchema: unsupported JSON schema keyword "format"');
    expect(http.calls).toHaveLength(0);
  });

  it("returns the model the response names, not the one requested", async () => {
    const http = fakeFetch([{ status: 200, body: { ...message("{}"), model: "claude-opus-5-5-test-snapshot" } }]);
    const res = await new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch }).generate(request());
    expect(http.calls[0]!.body.model).toBe("claude-opus-5-5");
    expect(res.model).toBe("claude-opus-5-5-test-snapshot");
  });

  it("never puts the API key in an error message", async () => {
    const http = fakeFetch([{ status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } }]);
    const provider = new AnthropicProvider({ apiKey: "sk-secret-123", model: "claude-opus-5-5", fetch: http.fetch });
    await expect(provider.generate(request())).rejects.toSatisfy((e: Error) => !e.message.includes("sk-secret-123"));
  });

  it("names the provider's error type in the message, never its text or the key", async () => {
    const http = fakeFetch([{ status: 402, body: { type: "error", error: { type: "billing_error", message: "Your credit balance is too low" } } }]);
    const provider = new AnthropicProvider({ apiKey: "sk-secret-402", model: "claude-opus-5-5", fetch: http.fetch });
    const error: unknown = await provider.generate(request()).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ProviderError", kind: "auth", message: "Anthropic request failed (auth, HTTP 402, billing_error)" });
    expect((error as Error).message).not.toContain("credit balance");
    expect((error as Error).message).not.toContain("sk-secret-402");
  });

  it("keeps an error type of exactly 64 characters", async () => {
    const type = "a".repeat(64);
    const http = fakeFetch([{ status: 400, body: { type: "error", error: { type, message: "m" } } }]);
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch });
    await expect(provider.generate(request())).rejects.toMatchObject({ kind: "bad_request", message: `Anthropic request failed (bad_request, HTTP 400, ${type})` });
  });

  it.each([
    ["a space and markup", "x y<script>"],
    ["capital letters", "Billing_Error"],
    ["a line break", "billing_error\n"],
    ["65 characters", "a".repeat(65)],
    ["no characters", ""],
    ["a number", 402],
    ["an object", { code: "billing_error" }],
  ])("leaves out a provider error type with %s", async (_label, type) => {
    const http = fakeFetch([{ status: 400, body: { type: "error", error: { type, message: "m" } } }]);
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch });
    await expect(provider.generate(request())).rejects.toMatchObject({ kind: "bad_request", message: "Anthropic request failed (bad_request, HTTP 400)" });
  });

  it("never lets an ANTHROPIC_BASE_URL environment variable redirect requests", async () => {
    const saved = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "https://evil.example";
    try {
      const http = fakeFetch([{ status: 200, body: message("{}") }]);
      await new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch }).generate(request());
      expect(http.calls).toHaveLength(1);
      expect(http.calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = saved;
    }
  });

  it("never sends an Authorization header from an ANTHROPIC_AUTH_TOKEN environment variable", async () => {
    await withEnv("ANTHROPIC_AUTH_TOKEN", "bogus-token-for-test", async () => {
      const http = fakeFetch([{ status: 200, body: message("{}") }]);
      await new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch }).generate(request());
      expect(http.calls).toHaveLength(1);
      expect(http.calls[0]!.headers.get("authorization")).toBeNull();
      expect(http.calls[0]!.headers.get("x-api-key")).toBe("k");
    });
  });

  it("logs nothing (the SDK logs to console) when ANTHROPIC_LOG=debug is set, on success or failure", async () => {
    const spies = (["debug", "info", "log", "warn", "error"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    try {
      await withEnv("ANTHROPIC_LOG", "debug", async () => {
        const http = fakeFetch([{ status: 200, body: message("{}") }, { status: 500, body: { type: "error", error: { type: "api_error", message: "m" } } }]);
        const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch });
        await provider.generate(request());
        await expect(provider.generate(request())).rejects.toMatchObject({ kind: "unavailable" });
        expect(http.calls).toHaveLength(2);
      });
      expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it.each([
    ["the documented counts", { input_tokens: 3200, output_tokens: 1400 }, { inputTokens: 3200, outputTokens: 1400 }],
    ["zero counts", { input_tokens: 0, output_tokens: 0 }, { inputTokens: 0, outputTokens: 0 }],
    ["counts of exactly 10,000,000 (P3-11 l)", { input_tokens: 10_000_000, output_tokens: 10_000_000 }, { inputTokens: 10_000_000, outputTokens: 10_000_000 }],
  ])("omits usageMissing when the message has usage with %s", async (_label, usage, expected) => {
    const http = fakeFetch([{ status: 200, body: { ...message("{}"), usage } }]);
    const res = await new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch }).generate(request());
    expect(res.usage).toEqual(expected);
    expect(Object.hasOwn(res, "usageMissing")).toBe(false);
  });

  it("returns usage 0/0 and usageMissing when a message has no usage", async () => {
    const http = fakeFetch([{ status: 200, body: { ...message('{"a":1}'), usage: undefined } }]);
    const res = await new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch }).generate(request());
    expect(res).toEqual({ json: { a: 1 }, model: "claude-opus-5-5", usage: { inputTokens: 0, outputTokens: 0 }, stop: "end", usageMissing: true });
  });

  it("sets usageMissing on a cut-off answer without usage too", async () => {
    const http = fakeFetch([{ status: 200, body: { ...message("{", "max_tokens"), usage: undefined } }]);
    const res = await new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch }).generate(request());
    expect(res).toEqual({ json: undefined, model: "claude-opus-5-5", usage: { inputTokens: 0, outputTokens: 0 }, stop: "max_tokens", usageMissing: true });
  });

  it.each([
    ["null", null, { inputTokens: 0, outputTokens: 0 }],
    ["no counts", {}, { inputTokens: 0, outputTokens: 0 }],
    ["no output_tokens", { input_tokens: 3200 }, { inputTokens: 3200, outputTokens: 0 }],
    ["a negative input_tokens", { input_tokens: -1, output_tokens: 1400 }, { inputTokens: 0, outputTokens: 1400 }],
    ["a null input_tokens", { input_tokens: null, output_tokens: 1400 }, { inputTokens: 0, outputTokens: 1400 }],
    ["a text output_tokens", { input_tokens: 3200, output_tokens: "1400" }, { inputTokens: 3200, outputTokens: 0 }],
    // P3-11 (l): a usable count is a finite integer from 0 to 10,000,000.
    ["a fractional input_tokens", { input_tokens: 1.5, output_tokens: 1400 }, { inputTokens: 0, outputTokens: 1400 }],
    ["an input_tokens of 1e308", { input_tokens: 1e308, output_tokens: 1400 }, { inputTokens: 0, outputTokens: 1400 }],
    ["an output_tokens of 10,000,001", { input_tokens: 3200, output_tokens: 10_000_001 }, { inputTokens: 3200, outputTokens: 0 }],
  ])("keeps only valid counts and sets usageMissing for usage with %s", async (_label, usage, expected) => {
    const http = fakeFetch([{ status: 200, body: { ...message("{}"), usage } }]);
    const res = await new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch }).generate(request());
    expect(res.usage).toEqual(expected);
    expect(res.usageMissing).toBe(true);
  });

  it("treats a count too large for a number (1e400 parses to Infinity) as missing", async () => {
    const text = JSON.stringify(message("{}")).replace('"input_tokens":3200', '"input_tokens":1e400');
    expect(text).toContain('"input_tokens":1e400');
    const fetch = async (): Promise<Response> => new Response(text, { status: 200, headers: { "content-type": "application/json" } });
    const res = await new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch }).generate(request());
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 1400 });
    expect(res.usageMissing).toBe(true);
  });
});

// P3-11 (e), one status rule in both adapters: 401/402/403 auth first; 408 and 504 timeout; 409 unavailable; 429
// rate_limited (the spend cap aside); every other 4xx a bad request (never retried); any other 5xx unavailable.
// Groq's 498 is the compatible adapter's own case, so here it is an ordinary 4xx.
describe("AnthropicProvider: the status rule (P3-11 e)", () => {
  it.each([
    [404, "bad_request"],
    [405, "bad_request"],
    [408, "timeout"],
    [409, "unavailable"],
    [410, "bad_request"],
    [413, "bad_request"],
    [418, "bad_request"],
    [424, "bad_request"],
    [429, "rate_limited"],
    [451, "bad_request"],
    [498, "bad_request"],
    [499, "bad_request"],
    [502, "unavailable"],
    [529, "unavailable"],
  ])("maps HTTP %i to %s, with no SDK retry", async (status, kind) => {
    const http = fakeFetch([{ status, body: { type: "error", error: { type: "x", message: "m" } } }, { status: 200, body: message("{}") }]);
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch });
    await expect(provider.generate(request())).rejects.toMatchObject({ name: "ProviderError", kind, message: `Anthropic request failed (${kind}, HTTP ${status}, x)` });
    expect(http.calls).toHaveLength(1);
  });
});

// P3-11 (k): a key an HTTP header cannot carry as typed is refused at construction as auth: no request, no retry.
describe("AnthropicProvider: a key a header cannot carry (P3-11 k)", () => {
  it.each([
    ["spaces only", "   "],
    ["a newline inside", `sk-ant-a${String.fromCharCode(10)}b`],
    ["a control character", `sk-ant-a${String.fromCharCode(1)}b`],
    ["an em dash", `sk-ant-a${String.fromCharCode(0x2014)}b`],
  ])("refuses a key with %s as auth before any request", (_name, apiKey) => {
    const http = fakeFetch([{ status: 200, body: message("{}") }]);
    expect(() => new AnthropicProvider({ apiKey, model: "claude-opus-5-5", fetch: http.fetch })).toThrow(
      expect.objectContaining({ name: "ProviderError", kind: "auth", message: "ANTHROPIC_API_KEY is blank or holds a character an HTTP header cannot carry" }),
    );
    expect(http.calls).toHaveLength(0);
  });
});

// P3-11 (t): a provider token (the error type, and the spend-cap code) that shares 8 or more characters with the key,
// ignoring case, is left out of the message.
describe("AnthropicProvider: key fragments in error tokens (P3-11 t)", () => {
  it.each([
    ["the key's start", "gsk_live"],
    ["a lowercase middle of the key", "abcdef12"],
  ])("leaves out an error type that is %s", async (_name, type) => {
    const http = fakeFetch([{ status: 402, body: { type: "error", error: { type, message: "m" } } }]);
    const provider = new AnthropicProvider({ apiKey: "gsk_live_abcDEF123", model: "claude-opus-5-5", fetch: http.fetch });
    await expect(provider.generate(request())).rejects.toMatchObject({ kind: "auth", message: "Anthropic request failed (auth, HTTP 402)" });
  });

  // A key shorter than 8 characters is matched whole: the token holds the key, not the other way round (review survivor A6).
  it("leaves out an error type that holds a short key whole", async () => {
    const http = fakeFetch([{ status: 402, body: { type: "error", error: { type: "xk1aby", message: "m" } } }]);
    const provider = new AnthropicProvider({ apiKey: "k1aB", model: "claude-opus-5-5", fetch: http.fetch });
    await expect(provider.generate(request())).rejects.toMatchObject({ kind: "auth", message: "Anthropic request failed (auth, HTTP 402)" });
  });

  it("keeps an error type that shares no fragment with the key", async () => {
    const http = fakeFetch([{ status: 402, body: { type: "error", error: { type: "billing_error", message: "m" } } }]);
    const provider = new AnthropicProvider({ apiKey: "gsk_live_abcDEF123", model: "claude-opus-5-5", fetch: http.fetch });
    await expect(provider.generate(request())).rejects.toMatchObject({ kind: "auth", message: "Anthropic request failed (auth, HTTP 402, billing_error)" });
  });

  it("leaves out the spend-cap code when the key shares a fragment with it, keeping the kind", async () => {
    const http = fakeFetch([{ status: 429, body: spendCapBody({ error_code: SPEND_CAP }) }]);
    const provider = new AnthropicProvider({ apiKey: "sk-ant-ENFORCED_SPEND-x", model: "claude-opus-5-5", fetch: http.fetch });
    await expect(provider.generate(request())).rejects.toMatchObject({ kind: "auth", message: "Anthropic request failed (auth, HTTP 429, rate_limit_error)" });
  });
});

// P3-11 (b): in Node the SDK merges ANTHROPIC_CUSTOM_HEADERS ("name: value" lines) into its default headers, which it
// sends after its own auth headers. Our key and no authorization header must still be what goes out.
describe("AnthropicProvider: ANTHROPIC_CUSTOM_HEADERS never replaces the credentials (P3-11 b)", () => {
  const newline = String.fromCharCode(10);

  it.each([
    ["lower-case names", `x-api-key: env-key-marker${newline}authorization: Bearer env-token-marker`],
    ["mixed-case names", `X-Api-Key: env-key-marker${newline}Authorization: Bearer env-token-marker`],
  ])("sends our x-api-key and no authorization when the variable sets both with %s", async (_label, value) => {
    await withEnv("ANTHROPIC_CUSTOM_HEADERS", value, async () => {
      const http = fakeFetch([{ status: 200, body: message("{}") }]);
      await new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch }).generate(request());
      expect(http.calls).toHaveLength(1);
      expect(http.calls[0]!.headers.get("x-api-key")).toBe("k");
      expect(http.calls[0]!.headers.get("authorization")).toBeNull();
    });
  });
});

// P3-11 (c): redirects are never followed (fetch's redirect "manual"): a followed redirect would carry every header,
// the key included, to another host. The SDK turns a 3xx into an APIError with that status: a wrong host, a bad request.
describe("AnthropicProvider: redirects (P3-11 c)", () => {
  it("asks fetch not to follow redirects", async () => {
    const http = fakeFetch([{ status: 200, body: message("{}") }]);
    await new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch }).generate(request());
    expect(http.calls[0]!.redirect).toBe("manual");
  });

  it.each([300, 301, 302, 303, 307, 308])("maps HTTP %i to bad_request, with no SDK retry", async (status) => {
    const http = fakeFetch([{ status, body: { type: "error", error: { type: "x", message: "moved" } } }, { status: 200, body: message("{}") }]);
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch });
    await expect(provider.generate(request())).rejects.toMatchObject({ name: "ProviderError", kind: "bad_request", message: `Anthropic request failed (bad_request, HTTP ${status}, x)` });
    expect(http.calls).toHaveLength(1);
  });
});

// P3-11 (f), api/rate-limits.md "Setting your own spend limit": "requests return HTTP 400 with error type
// `invalid_request_error`. The message begins `You have reached your specified API usage limits`, or `You have reached
// your specified workspace API usage limits` for a workspace limit". Such a 400 stays a bad request and its message
// names our fixed token SPEND_CAP, never the provider's text.
describe("AnthropicProvider: a spend limit you set (P3-11 f)", () => {
  const ORG_LIMIT = "You have reached your specified API usage limits";
  const limitBody = (text: unknown) => ({ type: "error", error: { type: "invalid_request_error", message: text } });
  const failWith = (status: number, body: unknown, apiKey = "k") =>
    new AnthropicProvider({ apiKey, model: "claude-opus-5-5", fetch: fakeFetch([{ status, body }]).fetch }).generate(request()).catch((e: unknown) => e);

  it.each([
    ["an organization limit", `${ORG_LIMIT}. You will regain access on 2026-10-01 at 00:00 UTC.`],
    ["a workspace limit", "You have reached your specified workspace API usage limits. You will regain access on 2026-10-01 at 00:00 UTC."],
  ])("names SPEND_CAP for %s, keeping it a bad request, never the provider's text", async (_label, text) => {
    const error = await failWith(400, limitBody(text));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "bad_request", message: "Anthropic request failed (bad_request, HTTP 400, invalid_request_error, SPEND_CAP)" });
    expect((error as Error).message).not.toContain("regain");
  });

  it.each([
    ["the prefix later in the message", `Error: ${ORG_LIMIT}`],
    ["the prefix in lower case", ORG_LIMIT.toLowerCase()],
    ["the tier cap's wording", "You have reached your API usage limits"],
    ["a message that is a list", [ORG_LIMIT]],
    ["no message", undefined],
  ])("names no SPEND_CAP for a 400 with %s", async (_label, text) => {
    expect(await failWith(400, limitBody(text))).toMatchObject({ kind: "bad_request", message: "Anthropic request failed (bad_request, HTTP 400, invalid_request_error)" });
  });

  it("names no SPEND_CAP when the prefix is only at the top level of the body", async () => {
    const body = { type: "error", message: ORG_LIMIT, error: { type: "invalid_request_error", message: "m" } };
    expect(await failWith(400, body)).toMatchObject({ kind: "bad_request", message: "Anthropic request failed (bad_request, HTTP 400, invalid_request_error)" });
  });

  it.each([
    [429, "rate_limited"],
    [403, "auth"],
    [422, "bad_request"],
    [500, "unavailable"],
  ])("names SPEND_CAP only on a 400: HTTP %i stays %s with no token", async (status, kind) => {
    expect(await failWith(status, limitBody(ORG_LIMIT))).toMatchObject({ kind, message: `Anthropic request failed (${kind}, HTTP ${status}, invalid_request_error)` });
  });
});
