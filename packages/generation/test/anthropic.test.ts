import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPS_REPAIR, CAPS_SNAPSHOT } from "../eval/caps.ts";
import { generateDraft, MAX_OUTPUT_TOKENS } from "../src/generate.ts";
import { MODELS } from "../src/models.ts";
import { buildPrompt, type Prompt } from "../src/prompt.ts";
import { ProviderError } from "../src/provider.ts";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { templateAnswer } from "../src/template.ts";
import { AI_DRAFT_JSON_SCHEMA, toWireSchema } from "../src/wire-schema.ts";
import { abortedSignal, fakeFetch } from "./support/http.ts";
import { BRIEF, FULL_FACTS, FULL_SNAPSHOT } from "./support/samples.ts";

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

  it("maps a 200 whose JSON body does not parse to unavailable", async () => {
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

  // P3-16 fix 3, the mirror of openai-compatible.test.ts's "lets an error from our own request building propagate": the
  // SDK writes the body with JSON.stringify inside the call (internal/request-options.mjs:16), so the adapter builds and
  // writes it once before its try.
  it.each([
    ["a schema toWireSchema refuses", { type: "object", patternProperties: {} }, 'toWireSchema: unsupported JSON schema keyword "patternProperties"'],
    ["a body JSON.stringify cannot write", { type: "object", enum: [{ toJSON: () => { throw new Error("our own bug"); } }] }, "our own bug"],
  ])("lets an error from our own request building propagate for %s, and sends nothing", async (_name, jsonSchema, message) => {
    const http = fakeFetch([]);
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch });
    const error: unknown = await provider.generate({ ...request(), jsonSchema }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ProviderError);
    expect((error as Error).message).toBe(message);
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

  // Fix r1 (I1) and r2 (F2): the variable can spell one header TWICE, in two different cases. buildHeaders
  // (internal/headers.mjs:68-107) gives every plain-object header source a "clear, then set" pass per entry
  // (iterateHeaders sets shouldClear for a plain object at headers.mjs:22-25 and yields the clear at 39-42), and a
  // native Headers delete/append is case-insensitive, so within ONE source the LAST-listed spelling of a name wins.
  // generate() sends our credentials as PER-REQUEST headers, the last source (client.mjs:840, the last entry of the
  // list at 825-841), so they win whatever the variable spelled, in either order.
  // What these four rows proved, stated plainly: at 5bcac54 our credentials were only in defaultHeaders, which the SDK
  // builds as `{ ...parsed, ...defaultHeaders }` (client.mjs:125). The two "lower-case then mixed-case" rows were RED
  // there. The two "mixed-case then lower-case" rows were already GREEN there: a spread keeps a key's first-insertion
  // position, so our lower-case key replaced the variable's lower-case entry in place, was listed after its mixed-case
  // spelling, and won (buildHeaders, headers.mjs:68-107). All four stay as regression pins: each is RED when the
  // per-request and the default credential headers are both removed.
  it.each([
    ["lower-case then mixed-case", `x-api-key: env-key-marker${newline}X-Api-Key: env-key-marker-2`],
    ["mixed-case then lower-case", `X-Api-Key: env-key-marker${newline}x-api-key: env-key-marker-2`],
  ])("keeps our x-api-key when the variable spells that header twice (%s)", async (_label, value) => {
    await withEnv("ANTHROPIC_CUSTOM_HEADERS", value, async () => {
      const http = fakeFetch([{ status: 200, body: message("{}") }]);
      await new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch }).generate(request());
      expect(http.calls).toHaveLength(1);
      expect(http.calls[0]!.headers.get("x-api-key")).toBe("k");
    });
  });

  it.each([
    ["lower-case then mixed-case", `authorization: env-token-marker${newline}Authorization: Bearer env-token-marker-2`],
    ["mixed-case then lower-case", `Authorization: Bearer env-token-marker${newline}authorization: env-token-marker-2`],
  ])("sends no authorization when the variable spells that header twice (%s)", async (_label, value) => {
    await withEnv("ANTHROPIC_CUSTOM_HEADERS", value, async () => {
      const http = fakeFetch([{ status: 200, body: message("{}") }]);
      await new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch }).generate(request());
      expect(http.calls).toHaveLength(1);
      expect(http.calls[0]!.headers.get("authorization")).toBeNull();
      expect(http.calls[0]!.headers.get("x-api-key")).toBe("k");
    });
  });

  // Part B review, round 1: buildHeaders passes the variable's x-api-key or authorization value to Headers.append
  // (internal/headers.mjs:101) inside buildRequest (client.mjs:811), before any fetch (518). A value the Headers class
  // rejects (a CR inside, a character above U+00FF) throws a TypeError there, which kindOf makes unavailable: nothing
  // is sent. The three lower-case rows were RED while our credentials were also in the SDK's defaultHeaders option
  // (6761ef6): `{ ...parsed, ...defaultHeaders }` (client.mjs:125) replaced the entry named exactly x-api-key or
  // authorization before Headers saw it, and the request went out with our key. The mixed-case row was GREEN there too
  // (a different object key, so nothing replaced it); it pins "in any case".
  const cr = String.fromCharCode(13);
  it.each([
    ["x-api-key with a CR inside", `x-api-key: a${cr}b`],
    ["x-api-key with a character above U+00FF", `x-api-key: a${String.fromCharCode(0x20ac)}`],
    ["authorization with a CR inside", `authorization: a${cr}b`],
    ["X-Api-Key with a CR inside", `X-Api-Key: a${cr}b`],
  ])("fails before any fetch, as unavailable, when the variable gives %s", async (_label, value) => {
    await withEnv("ANTHROPIC_CUSTOM_HEADERS", value, async () => {
      const http = fakeFetch([{ status: 200, body: message("{}") }]);
      const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: http.fetch });
      await expect(provider.generate(request())).rejects.toMatchObject({ name: "ProviderError", kind: "unavailable", message: "Anthropic request failed (unavailable)" });
      expect(http.calls).toHaveLength(0);
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

  // Fix r2 (F4 d), moderator decision: SPEND_CAP is our own fixed token, not provider text, so the key-fragment filter
  // (sharesKeyFragment, P3-11 t) never removes it, even for a key that shares 8 or more characters with it.
  it("names SPEND_CAP even when the key shares a fragment with it", async () => {
    const apiKey = "sk-ant-spend_ca-x1";
    const error = await failWith(400, limitBody(ORG_LIMIT), apiKey);
    expect(error).toMatchObject({ kind: "bad_request", message: "Anthropic request failed (bad_request, HTTP 400, invalid_request_error, SPEND_CAP)" });
    expect((error as Error).message).not.toContain(apiKey);
  });
});

/** A provider for the model claude-opus-5-5 on this fetch. */
const anthropic = (fetchImpl: typeof fetch) => new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: fetchImpl });

/** The answer to one request whose response is a 200 with this body. */
const answer = (body: unknown) => anthropic(fakeFetch([{ status: 200, body }]).fetch).generate(request());

/**
 * A fetch whose response (this status) arrives first; then our signal aborts while the body is read, and the body
 * stream errors with the abort reason, as a real fetch's does (Fetch Standard, "abort a fetch() call"). The SDK passes
 * fetch a signal of its own, which our abort aborts in turn.
 */
const abortMidBody = (controller: AbortController, status: number) => async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
  new Response(
    new ReadableStream({
      pull: (stream) => {
        controller.abort(new DOMException("timed out", "TimeoutError"));
        stream.error(init?.signal?.reason);
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  );

/** A fetch whose response has this status and a body stream that fails when read (a dropped connection). */
const unreadable = (status: number) => async (): Promise<Response> =>
  new Response(new ReadableStream({ start: (controller) => controller.error(new TypeError("terminated")) }), { status });

const VALID_ANSWER = { status: 200, body: message(JSON.stringify(templateAnswer(FULL_FACTS, BRIEF))) };
const DEPS = { sleep: async () => {}, timeoutSignal: () => new AbortController().signal, now: () => 0 };

describe("AnthropicProvider: our abort while the body is read (P3-11 a)", () => {
  it.each([200, 302, 400, 401, 429, 503])("maps HTTP %i whose body read our abort cut short to timeout", async (status) => {
    const controller = new AbortController();
    await expect(anthropic(abortMidBody(controller, status)).generate(request(controller.signal))).rejects.toMatchObject({ name: "ProviderError", kind: "timeout" });
    expect(controller.signal.aborted).toBe(true);
  });
});

// P3-11 (d): an error after a 2xx status line carries afterHeaders (the provider accepted the call and may bill it,
// but its usage is unknown), so generateDraft marks that attempt's usage missing. An error status (3xx, 4xx, 5xx)
// means the call was refused: the key is left out (exactOptionalPropertyTypes), as it is for a failed fetch.
describe("AnthropicProvider: errors after a 2xx status line (P3-11 d)", () => {
  it.each([
    ["a body that is not JSON", () => rawFetch(200, '{"id":')],
    ["a JSON null body", () => rawFetch(200, "null")],
    ["a JSON list body", () => rawFetch(200, "[]")],
    ["no content", () => fakeFetch([{ status: 200, body: { ...message("{}"), content: undefined } }]).fetch],
    ["content that is a string", () => fakeFetch([{ status: 200, body: { ...message("{}"), content: "{}" } }]).fetch],
    ["content that is one block, not a list", () => fakeFetch([{ status: 200, body: { ...message("{}"), content: { type: "text", text: "{}" } } }]).fetch],
    ["content that is null", () => fakeFetch([{ status: 200, body: { ...message("{}"), content: null } }]).fetch],
    ["no body (a 204)", () => async (): Promise<Response> => new Response(null, { status: 204 })],
    ["a body that cannot be read", () => unreadable(200)],
  ])("maps a 2xx with %s to unavailable with afterHeaders", async (_label, fetchOf) => {
    const error: unknown = await anthropic(fetchOf()).generate(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: "unavailable", message: "Anthropic request failed (unavailable)", afterHeaders: true });
  });

  it("marks a 2xx whose body read our abort cut short a timeout with afterHeaders", async () => {
    const controller = new AbortController();
    const error: unknown = await anthropic(abortMidBody(controller, 200)).generate(request(controller.signal)).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ProviderError", kind: "timeout", afterHeaders: true });
  });

  // Fix r2 (F1): once the 2xx headers are in, the SDK has cleared its own 90 s timer (client.mjs:667-674), so only our
  // per-attempt signal can end a body that never finishes. The SDK links our signal to the controller whose signal it
  // hands fetch (client.mjs:646-648, 653) and keeps that link until the body is settled (internal/request-signal.mjs:
  // 9-13). This body never ends on its own: it errors only when the signal fetch was given aborts, as a real fetch's
  // body does (Fetch Standard, "abort a fetch() call"). If our signal stopped reaching fetch at the headers, the read
  // would hang and the 3 s test timeout would fail the test.
  const neverEndingBody = (controller: AbortController, prefix: string) => async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start: (stream) => {
        if (prefix !== "") stream.enqueue(new TextEncoder().encode(prefix));
        if (signal) signal.addEventListener("abort", () => stream.error(signal.reason), { once: true });
      },
    });
    // The attempt's deadline passes 50 ms after the headers are sent.
    setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), 50);
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };

  it.each([
    ["no bytes", ""],
    ["a partial JSON prefix", '{"id":"msg_1","type":"message","content":[{"type":"text","text":"{'],
  ])(
    "bounds a 2xx body that never ends (%s sent) by the per-attempt signal: timeout with afterHeaders",
    async (_label, prefix) => {
      const controller = new AbortController();
      const error: unknown = await anthropic(neverEndingBody(controller, prefix)).generate(request(controller.signal)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ name: "ProviderError", kind: "timeout", message: "Anthropic request failed (timeout)", afterHeaders: true });
    },
    3_000,
  );

  const errorBody = { type: "error", error: { type: "x", message: "m" } };
  it.each([
    ["a 302", () => fakeFetch([{ status: 302, body: errorBody }]).fetch],
    ["a 400", () => fakeFetch([{ status: 400, body: errorBody }]).fetch],
    ["a 429", () => fakeFetch([{ status: 429, body: errorBody }]).fetch],
    ["a 503", () => fakeFetch([{ status: 503, body: errorBody }]).fetch],
    ["a 401 whose body cannot be read", () => unreadable(401)],
    ["a network failure", () => fakeFetch([new TypeError("fetch failed")]).fetch],
  ])("leaves afterHeaders out of the error for %s", async (_label, fetchOf) => {
    const error: unknown = await anthropic(fetchOf()).generate(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(Object.hasOwn(error as object, "afterHeaders")).toBe(false);
  });

  it("leaves afterHeaders out of a 429 whose body read our abort cut short (a timeout: its usage is marked missing anyway)", async () => {
    const controller = new AbortController();
    const error: unknown = await anthropic(abortMidBody(controller, 429)).generate(request(controller.signal)).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ProviderError", kind: "timeout" });
    expect(Object.hasOwn(error as object, "afterHeaders")).toBe(false);
  });

  it.each([
    ["a 2xx with no content", { status: 200, body: { ...message("{}"), content: undefined } }, [["unavailable", true], ["valid", false]]],
    ["a 2xx that is not an object", { status: 200, body: "text" }, [["unavailable", true], ["valid", false]]],
    ["a 400, a refused call", { status: 400, body: errorBody }, [["bad_request", false]]],
    ["a 503, a refused call", { status: 503, body: errorBody }, [["unavailable", false], ["valid", false]]],
  ])("lets generateDraft record whether usage is missing after %s", async (_label, first, log) => {
    const result = await generateDraft(anthropic(fakeFetch([first, VALID_ANSWER]).fetch), FULL_SNAPSHOT, DEPS);
    expect(result.log.map((a) => [a.outcome, a.usageMissing])).toEqual(log);
  });

  it("lets generateDraft mark usage missing after our abort cut a 2xx body short", async () => {
    const controller = new AbortController();
    const signals = [controller.signal, new AbortController().signal];
    const answers = [abortMidBody(controller, 200), fakeFetch([VALID_ANSWER]).fetch];
    const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => answers.shift()!(input, init);
    const result = await generateDraft(anthropic(fetchImpl), FULL_SNAPSHOT, { ...DEPS, timeoutSignal: () => signals.shift()! });
    expect(result.log.map((a) => [a.outcome, a.usageMissing])).toEqual([["timeout", true], ["valid", false]]);
  });

  it("maps an SDK failure that is not an APIError (fetch resolved to something that is not a Response) to unavailable", async () => {
    const notAResponse = (async () => ({})) as unknown as typeof fetch;
    const error: unknown = await anthropic(notAResponse).generate(request()).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ProviderError", kind: "unavailable", message: "Anthropic request failed (unavailable)" });
    expect(Object.hasOwn(error as object, "afterHeaders")).toBe(false);
  });
});

// P3-16 fix 5: an error raised when the call was made but no status line came back carries noResponse, so generateDraft
// marks that attempt's usage missing: the provider may have received the request and billed it. In the SDK that is an
// APIConnectionError (the fetch rejected; its APIConnectionTimeoutError subclass included, client.mjs:569 and :576) or
// an APIUserAbortError (our signal aborted before the headers, client.mjs:515 and :527). An error with a status line
// never carries it.
describe("AnthropicProvider: errors with no status line (P3-16 fix 5)", () => {
  const refusal = { type: "error", error: { type: "x", message: "m" } };

  it.each([
    ["a fetch that rejected (the SDK's APIConnectionError)", new TypeError("fetch failed"), "unavailable"],
    ["the SDK's own timer aborting the fetch (APIConnectionTimeoutError)", new DOMException("This operation was aborted", "AbortError"), "timeout"],
  ])("marks %s noResponse", async (_label, failure, kind) => {
    const http = fakeFetch([failure]);
    const error: unknown = await anthropic(http.fetch).generate(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind, noResponse: true });
    expect(Object.hasOwn(error as object, "afterHeaders")).toBe(false);
    expect(http.calls).toHaveLength(1);
  });

  it("marks our abort while the fetch waited for the headers (the SDK's APIUserAbortError) a timeout with noResponse", async () => {
    const controller = new AbortController();
    let calls = 0;
    const abortsBeforeHeaders = async (): Promise<Response> => {
      calls += 1;
      controller.abort(new DOMException("timed out", "TimeoutError"));
      throw new DOMException("The operation was aborted.", "AbortError");
    };
    const error: unknown = await anthropic(abortsBeforeHeaders).generate(request(controller.signal)).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ProviderError", kind: "timeout", noResponse: true });
    expect(calls).toBe(1);
  });

  it.each([
    ["a 302", () => fakeFetch([{ status: 302, body: refusal }]).fetch],
    ["a 400", () => fakeFetch([{ status: 400, body: refusal }]).fetch],
    ["a 429", () => fakeFetch([{ status: 429, body: refusal }]).fetch],
    ["a 503", () => fakeFetch([{ status: 503, body: refusal }]).fetch],
    ["a 401 whose body cannot be read", () => unreadable(401)],
    ["a 2xx whose body is not JSON (afterHeaders)", () => rawFetch(200, '{"id":')],
  ])("leaves noResponse out of the error for %s", async (_label, fetchOf) => {
    const error: unknown = await anthropic(fetchOf()).generate(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(Object.hasOwn(error as object, "noResponse")).toBe(false);
  });

  it("leaves noResponse out of a 429 whose body read our abort cut short (its status line came)", async () => {
    const controller = new AbortController();
    const error: unknown = await anthropic(abortMidBody(controller, 429)).generate(request(controller.signal)).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ProviderError", kind: "timeout" });
    expect(Object.hasOwn(error as object, "noResponse")).toBe(false);
  });

  it.each([
    ["an APIConnectionError", new TypeError("fetch failed"), [["unavailable", true], ["valid", false]]],
    ["a 400 with its status line", { status: 400, body: refusal }, [["bad_request", false]]],
    ["a 503 with its status line", { status: 503, body: refusal }, [["unavailable", false], ["valid", false]]],
  ])("lets generateDraft record whether usage is missing after %s", async (_label, first, log) => {
    const result = await generateDraft(anthropic(fakeFetch([first, VALID_ANSWER]).fetch), FULL_SNAPSHOT, DEPS);
    expect(result.log.map((a) => [a.outcome, a.usageMissing])).toEqual(log);
  });
});

// P3-11 (d): every field of a 2xx answer is read only after a type check: the model is a string (else the requested
// id), content is a list, the text block is found by its type and its text is a string.
describe("AnthropicProvider: 2xx shape checks (P3-11 d)", () => {
  const usage = { inputTokens: 3200, outputTokens: 1400 };

  it.each([
    ["a number", 42],
    ["null", null],
    ["an object", { id: "claude-x" }],
    ["missing", undefined],
  ])("keeps the requested model when the body's model is %s", async (_label, model) => {
    expect(await answer({ ...message('{"a":1}'), model })).toStrictEqual({ json: { a: 1 }, model: "claude-opus-5-5", usage, stop: "end" });
  });

  it.each([
    ["a null block before the text block", [null, { type: "text", text: '{"a":1}' }], { a: 1 }],
    ["a number block before the text block", [7, { type: "text", text: '{"a":1}' }], { a: 1 }],
    ["a thinking block before the text block", [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: '{"a":1}' }], { a: 1 }],
    ["text in a block of another type only", [{ type: "tool_use", text: '{"a":1}' }], undefined],
    ["no text block", [{ type: "thinking", thinking: "", signature: "s" }], undefined],
    ["no blocks", [], undefined],
    ["a text block whose text is a number", [{ type: "text", text: 5 }], undefined],
    ["a text block whose text is an object", [{ type: "text", text: { a: 1 } }], undefined],
  ])("reads content with %s", async (_label, content, json) => {
    expect(await answer({ ...message("{}"), content })).toStrictEqual({ json, model: "claude-opus-5-5", usage, stop: "end" });
  });

  // M1: today's own(content.find(...), "text") reads the FIRST text block; a mutant swapping find for findLast would
  // read the second one instead and must fail this test.
  it("uses the first text block when the answer has two, after a thinking block", async () => {
    const content = [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: '{"a":1}' }, { type: "text", text: '{"a":2}' }];
    expect(await answer({ ...message("{}"), content })).toStrictEqual({ json: { a: 1 }, model: "claude-opus-5-5", usage, stop: "end" });
  });

  it.each([
    ["a number", 5],
    ["an object", { reason: "end_turn" }],
    ["a list holding end_turn", ["end_turn"]],
  ])("maps a stop_reason that is %s to other, with no JSON", async (_label, stop_reason) => {
    expect(await answer({ ...message('{"a":1}'), stop_reason })).toStrictEqual({ json: undefined, model: "claude-opus-5-5", usage, stop: "other" });
  });
});

// P3-11 (g) and (h): api/messages lists end_turn, max_tokens, stop_sequence, tool_use, pause_turn, refusal and
// model_context_window_exceeded, for which build-with-claude/handling-stop-reasons says "Treat the response as
// truncated". The text is valid JSON, so a stop that is not "end" must still give no JSON.
describe("AnthropicProvider: stop reasons (P3-11 g, h)", () => {
  it.each([
    ["max_tokens", "max_tokens"],
    ["model_context_window_exceeded", "max_tokens"],
    ["refusal", "refusal"],
    ["stop_sequence", "other"],
    ["tool_use", "other"],
    ["pause_turn", "other"],
    ["constructor", "other"],
    ["__proto__", "other"],
    ["toString", "other"],
    [null, "other"],
  ])("maps stop_reason %s to %s, with no JSON even when the text is valid JSON", async (stop_reason, stop) => {
    expect(await answer({ ...message('{"a":1}'), stop_reason })).toStrictEqual({ json: undefined, model: "claude-opus-5-5", usage: { inputTokens: 3200, outputTokens: 1400 }, stop });
  });
});

// P3-11 (i), api/messages: "Total input tokens in a request is the summation of `input_tokens`,
// `cache_creation_input_tokens`, and `cache_read_input_tokens`"; each cache count is typed "number or null".
describe("AnthropicProvider: cache tokens count as input (P3-11 i)", () => {
  const withUsage = (usage: unknown) => answer({ ...message('{"a":1}'), usage });

  it.each([
    ["both cache counts", { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 3, output_tokens: 5 }, 123],
    ["a cache write only", { input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 5 }, 120],
    ["a cache read only", { input_tokens: 100, cache_read_input_tokens: 3, output_tokens: 5 }, 103],
    ["null cache counts", { input_tokens: 100, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens: 5 }, 100],
    ["zero cache counts", { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 }, 100],
  ])("adds %s to the input tokens, leaving usageMissing out", async (_label, usage, inputTokens) => {
    expect(await withUsage(usage)).toStrictEqual({ json: { a: 1 }, model: "claude-opus-5-5", usage: { inputTokens, outputTokens: 5 }, stop: "end" });
  });

  it.each([
    ["a negative cache write", { input_tokens: 100, cache_creation_input_tokens: -1, cache_read_input_tokens: 3, output_tokens: 5 }, 103],
    ["a fractional cache read", { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 1.5, output_tokens: 5 }, 120],
    ["a text cache read", { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: "3", output_tokens: 5 }, 120],
    ["a cache write of 10,000,001", { input_tokens: 100, cache_creation_input_tokens: 10_000_001, cache_read_input_tokens: 3, output_tokens: 5 }, 103],
    ["no input_tokens", { cache_creation_input_tokens: 20, cache_read_input_tokens: 3, output_tokens: 5 }, 23],
  ])("keeps only usable counts and sets usageMissing for %s", async (_label, usage, inputTokens) => {
    expect(await withUsage(usage)).toStrictEqual({ json: { a: 1 }, model: "claude-opus-5-5", usage: { inputTokens, outputTokens: 5 }, stop: "end", usageMissing: true });
  });
});

// Fix r1b and r2 (F4 e): retriesRemaining starts at maxRetries (client.mjs:494-501), and we always construct the client
// with maxRetries: 0, so `if (retriesRemaining && shouldRetry)` (client.mjs:585, and the connection-error path at 551)
// is false whatever shouldRetry(response) returns. shouldRetry obeys the response's own x-should-retry header first
// (client.mjs:722-728, "Note this is not a standard header. ... If the server explicitly says whether or not to retry,
// obey.") and otherwise retries 408, 409, 429 and every status from 500 up (729-741). So "x-should-retry: true" changes
// the SDK's choice only for a status it would not retry by default: the 400 row is the one that fails when maxRetries
// is 1 because of the header; 429, 500 and 529 would be retried then with or without it. Exactly one fetch in every row.
describe("AnthropicProvider: no SDK retry even when the response says to (fix r1b)", () => {
  it.each([400, 429, 500, 529])("sends exactly one fetch for HTTP %i with x-should-retry: true", async (status) => {
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      return new Response(JSON.stringify({ type: "error", error: { type: "x", message: "m" } }), {
        status,
        headers: { "content-type": "application/json", "x-should-retry": "true" },
      });
    };
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-5-5", fetch: fetchImpl });
    await expect(provider.generate(request())).rejects.toMatchObject({ name: "ProviderError" });
    expect(calls).toBe(1);
  });
});

/**
 * Every own key of value, and of every object or array nested inside it, recursively (arrays included; a Set guards
 * against a circular reference, which JSON.stringify could never have produced in the first place). Returns the first
 * forbidden key found (for a clear failure message) or undefined.
 */
function findForbiddenKey(value: unknown, forbidden: ReadonlySet<string>, seen = new Set<object>()): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value as Record<string, unknown>);
  for (const [key, child] of entries) {
    if (typeof key === "string" && forbidden.has(key)) return key;
    const found = findForbiddenKey(child, forbidden, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

// Fix r2 (F3): models.ts prices every Anthropic model as if requests never cache and never use server tools. A
// cache_control field, on a content block or at the top level (automatic caching), makes cache writes cost 1.25x or 2x
// the input price (pricing.md, "Prompt caching"). A tools field adds its tokens to the input, and pricing.md says
// "Client-side tools are priced the same as any other Claude API request, although server-side tools can incur
// additional charges based on their specific usage", so banning any tools key is a conservative superset of the
// server-tools rule. What this guard proves: for every "anthropic:" entry in MODELS, with the real prompt of a first
// attempt and of a repair attempt at their largest (CAPS_SNAPSHOT, CAPS_REPAIR), the body the adapter hands fetch
// has no cache_control key and no tools key at any depth. It says nothing about a model id that is not in MODELS.
const ANTHROPIC_MODEL_IDS = Object.keys(MODELS)
  .filter((key) => key.startsWith("anthropic:"))
  .map((key) => key.slice("anthropic:".length));
const REAL_PROMPTS: Array<[string, Prompt]> = [
  ["a first attempt", buildPrompt(CAPS_SNAPSHOT, [])],
  ["a repair attempt", buildPrompt(CAPS_SNAPSHOT, CAPS_REPAIR)],
];
const GUARD_ROWS: Array<[string, string, Prompt]> = ANTHROPIC_MODEL_IDS.flatMap((model) => REAL_PROMPTS.map(([label, prompt]): [string, string, Prompt] => [model, label, prompt]));

describe("AnthropicProvider: never bills as if it cached or used tools (fix r2)", () => {
  it("has Anthropic models to check", () => {
    expect(ANTHROPIC_MODEL_IDS.length).toBeGreaterThan(0);
  });

  it.each(GUARD_ROWS)("sends no cache_control key and no tools key anywhere for model %s with the real prompt of %s", async (model, _label, prompt) => {
    const http = fakeFetch([{ status: 200, body: message('{"a":1}') }]);
    const provider = new AnthropicProvider({ apiKey: "k", model, fetch: http.fetch });
    await provider.generate({ ...prompt, jsonSchema: AI_DRAFT_JSON_SCHEMA, maxOutputTokens: MAX_OUTPUT_TOKENS, signal: new AbortController().signal });
    expect(http.calls).toHaveLength(1);
    const body = http.calls[0]!.body;
    // The real prompt was sent (in whatever shape), so the scan below looked at it.
    expect(body.model).toBe(model);
    expect(JSON.stringify(body)).toContain(JSON.stringify(prompt.system));
    expect(JSON.stringify(body)).toContain(JSON.stringify(prompt.user));
    expect(findForbiddenKey(body, new Set(["cache_control", "tools"]))).toBeUndefined();
  });
});
