import { describe, expect, it } from "vitest";
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
