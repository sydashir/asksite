import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.ts";
import { AI_DRAFT_JSON_SCHEMA, toWireSchema } from "../src/wire-schema.ts";
import { abortedSignal, fakeFetch } from "./support/http.ts";

// Chat Completions response shape (choices[].message.content, finish_reason, usage.prompt_tokens /
// completion_tokens), as documented by Groq's API reference and Cloudflare's OpenAI-compatible
// page, checked 2026-09-24. Task 15 adds recorded live responses (recorded.test.ts).
const completion = (content: string | null, finish_reason = "stop") => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "@cf/openai/gpt-oss-120b",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason }],
  usage: { prompt_tokens: 2900, completion_tokens: 1300, total_tokens: 4200 },
});

const request = (signal = new AbortController().signal) => ({ system: "SYS", user: "USER", jsonSchema: AI_DRAFT_JSON_SCHEMA, maxOutputTokens: 8192, signal });
const WORKERS_AI = "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1";

describe("OpenAICompatibleProvider", () => {
  it("POSTs chat/completions with a strict json_schema response format and a Bearer key", async () => {
    const http = fakeFetch([{ status: 200, body: completion('{"a":1}') }]);
    await new OpenAICompatibleProvider({ baseUrl: `${WORKERS_AI}/`, apiKey: "cf-test", model: "@cf/openai/gpt-oss-120b", fetch: http.fetch }).generate(request());
    const { url, headers, redirect, body } = http.calls[0]!;
    expect(url).toBe(`${WORKERS_AI}/chat/completions`);
    expect(headers.get("authorization")).toBe("Bearer cf-test");
    expect(redirect).toBe("manual");
    expect(body).toEqual({
      model: "@cf/openai/gpt-oss-120b",
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "USER" },
      ],
      max_tokens: 8192,
      response_format: { type: "json_schema", json_schema: { name: "site_draft", strict: true, schema: toWireSchema(AI_DRAFT_JSON_SCHEMA) } },
    });
  });

  it("adds the model's extra fields from the MODELS table", async () => {
    const http = fakeFetch([{ status: 200, body: completion("{}") }]);
    await new OpenAICompatibleProvider({ baseUrl: WORKERS_AI, apiKey: "k", model: "@cf/qwen/qwen3.8-27b", fetch: http.fetch }).generate(request());
    expect(http.calls[0]!.body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("returns parsed content with nulls removed, the model, usage and stop", async () => {
    const http = fakeFetch([{ status: 200, body: completion('{"copy":{"about":null,"x":"y"}}') }]);
    const res = await new OpenAICompatibleProvider({ baseUrl: WORKERS_AI, apiKey: "k", model: "@cf/openai/gpt-oss-120b", fetch: http.fetch }).generate(request());
    expect(res).toEqual({ json: { copy: { x: "y" } }, model: "@cf/openai/gpt-oss-120b", usage: { inputTokens: 2900, outputTokens: 1300 }, stop: "end" });
  });

  it.each([
    ["length", "max_tokens"],
    ["content_filter", "refusal"],
    ["tool_calls", "other"],
  ])("maps finish_reason %s to %s", async (reason, stop) => {
    const http = fakeFetch([{ status: 200, body: completion("{", reason) }]);
    const res = await new OpenAICompatibleProvider({ baseUrl: WORKERS_AI, apiKey: "k", model: "m", fetch: http.fetch }).generate(request());
    expect(res.stop).toBe(stop);
  });

  it("returns json undefined when the content is not JSON", async () => {
    const http = fakeFetch([{ status: 200, body: completion("Sure! Here is your site") }]);
    const res = await new OpenAICompatibleProvider({ baseUrl: WORKERS_AI, apiKey: "k", model: "m", fetch: http.fetch }).generate(request());
    expect(res).toMatchObject({ json: undefined, stop: "end" });
  });

  it.each([
    [302, "bad_request"],
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limited"],
    [400, "bad_request"],
    [422, "bad_request"],
    [500, "unavailable"],
    [503, "unavailable"],
  ])("maps HTTP %i to a %s ProviderError (a redirect is never followed)", async (status, kind) => {
    const http = fakeFetch([{ status, body: { error: { message: "m" } } }]);
    const provider = new OpenAICompatibleProvider({ baseUrl: WORKERS_AI, apiKey: "k", model: "m", fetch: http.fetch });
    await expect(provider.generate(request())).rejects.toMatchObject({ name: "ProviderError", kind });
  });

  it("maps a network failure to unavailable and our abort to timeout", async () => {
    const down = new OpenAICompatibleProvider({ baseUrl: WORKERS_AI, apiKey: "k", model: "m", fetch: fakeFetch([new TypeError("fetch failed")]).fetch });
    await expect(down.generate(request())).rejects.toMatchObject({ kind: "unavailable" });
    const slow = new OpenAICompatibleProvider({ baseUrl: WORKERS_AI, apiKey: "k", model: "m", fetch: fakeFetch([]).fetch });
    await expect(slow.generate(request(abortedSignal()))).rejects.toMatchObject({ kind: "timeout" });
  });

  it("maps a 200 without a usable body to unavailable", async () => {
    const http = fakeFetch([{ status: 200, body: { choices: [] } }]);
    const provider = new OpenAICompatibleProvider({ baseUrl: WORKERS_AI, apiKey: "k", model: "m", fetch: http.fetch });
    await expect(provider.generate(request())).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("never puts the API key in an error message", async () => {
    const provider = new OpenAICompatibleProvider({ baseUrl: WORKERS_AI, apiKey: "cf-secret-123", model: "m", fetch: fakeFetch([{ status: 401, body: { error: { message: "bad key cf-secret-123" } } }]).fetch });
    await expect(provider.generate(request())).rejects.toSatisfy((e: Error) => !e.message.includes("cf-secret-123"));
  });

  it("refuses a base URL that is not https", () => {
    expect(() => new OpenAICompatibleProvider({ baseUrl: "http://example.com/v1", apiKey: "k", model: "m" })).toThrow(/https/);
  });
});
