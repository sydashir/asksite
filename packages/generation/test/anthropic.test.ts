import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { AI_DRAFT_JSON_SCHEMA, toWireSchema } from "../src/wire-schema.ts";
import { abortedSignal, fakeFetch } from "./support/http.ts";

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
