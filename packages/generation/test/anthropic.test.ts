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
});
