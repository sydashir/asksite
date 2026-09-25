import { describe, expect, it } from "vitest";
import { generateDraft } from "../src/generate.ts";
import { MODELS, type ModelSettings } from "../src/models.ts";
import { buildPrompt } from "../src/prompt.ts";
import { ProviderError } from "../src/provider.ts";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.ts";
import { templateDraft } from "../src/template.ts";
import { checkDraft } from "../src/validate.ts";
import { AI_DRAFT_JSON_SCHEMA, toWireSchema } from "../src/wire-schema.ts";
import { abortedSignal, fakeFetch } from "./support/http.ts";
import { BRIEF, FULL_FACTS, FULL_SNAPSHOT } from "./support/samples.ts";

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
    [402, "auth"],
    [409, "unavailable"],
    [504, "timeout"],
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

/** A fetch that answers every call with this status and this exact body text, and records each request body as sent. */
const rawFetch = (status: number, text: string, contentType = "application/json") => {
  const bodies: string[] = [];
  const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return new Response(text, { status, headers: { "content-type": contentType } });
  };
  return { fetch, bodies };
};

/** A provider on the Workers AI base URL for the model "m". */
const compatible = (fetchImpl: typeof fetch, apiKey = "k") => new OpenAICompatibleProvider({ baseUrl: WORKERS_AI, apiKey, model: "m", fetch: fetchImpl });

// developers.cloudflare.com/workers-ai/features/json-mode: "an error `JSON Mode couldn't be met` is
// returned and must be handled". Its HTTP status and body shape are not documented.
const JSON_MODE_UNMET = "JSON Mode couldn't be met";

describe("OpenAICompatibleProvider: JSON Mode not met (task 7 additions A)", () => {
  it.each([
    ["a 400 with Cloudflare's errors list", 400, JSON.stringify({ errors: [{ message: JSON_MODE_UNMET }], success: false }), "application/json"],
    ["a 200 with the message in an error field", 200, JSON.stringify({ error: { message: JSON_MODE_UNMET } }), "application/json"],
    ["a 500 with a plain-text body", 500, `AiError: ${JSON_MODE_UNMET}`, "text/plain"],
  ])("answers %s as an answer with no JSON, never a ProviderError", async (_name, status, text, contentType) => {
    const res = await compatible(rawFetch(status, text, contentType).fetch).generate(request());
    expect(res).toStrictEqual({ json: undefined, model: "m", usage: { inputTokens: 0, outputTokens: 0 }, stop: "end", usageMissing: true });
  });

  it("keeps the model and the usage such an answer carries", async () => {
    const http = fakeFetch([{ status: 200, body: { model: "@cf/qwen/qwen3.8-27b", error: { message: JSON_MODE_UNMET }, usage: { prompt_tokens: 50, completion_tokens: 7 } } }]);
    const res = await compatible(http.fetch).generate(request());
    expect(res).toStrictEqual({ json: undefined, model: "@cf/qwen/qwen3.8-27b", usage: { inputTokens: 50, outputTokens: 7 }, stop: "end" });
  });

  it("still maps a 400 without the message to bad_request", async () => {
    const http = fakeFetch([{ status: 400, body: { errors: [{ message: "Invalid input" }], success: false } }]);
    await expect(compatible(http.fetch).generate(request())).rejects.toMatchObject({ name: "ProviderError", kind: "bad_request" });
  });

  it("lets generateDraft send repair feedback after it, then accept a valid answer", async () => {
    const http = fakeFetch([
      { status: 400, body: { errors: [{ message: JSON_MODE_UNMET }], success: false } },
      { status: 200, body: completion(JSON.stringify(templateDraft(FULL_FACTS, BRIEF))) },
    ]);
    const deps = { sleep: async () => {}, timeoutSignal: () => new AbortController().signal, now: () => 0 };
    const result = await generateDraft(compatible(http.fetch), FULL_SNAPSHOT, deps);
    expect(result).toMatchObject({ ok: true, validOnAttempt: 2, attempts: 2 });
    expect(result.log.map((a) => [a.outcome, a.usageMissing])).toEqual([
      ["invalid", true],
      ["valid", false],
    ]);
    const unmet = checkDraft(FULL_FACTS, undefined);
    if (unmet.ok) throw new Error("checkDraft accepted an answer with no JSON");
    const sentUser = http.calls.map((c) => (c.body.messages as Array<{ content: string }>)[1]!.content);
    expect(sentUser).toEqual([buildPrompt(FULL_SNAPSHOT).user, buildPrompt(FULL_SNAPSHOT, unmet.issues).user]);
  });
});

// Moderator decision (2026-09-26): the phrase counts only in the body of a failed (non-2xx) answer, or in the
// provider's error fields (a string error, error.message, errors[].message) whatever the status; never inside
// the model's own text of a 2xx answer, which may quote it.
describe("OpenAICompatibleProvider: where JSON Mode not met counts (moderator decision)", () => {
  const quoting = { copy: { about: `The page said ${JSON_MODE_UNMET} once.` } };
  const answered = { json: undefined, model: "m", usage: { inputTokens: 0, outputTokens: 0 }, stop: "end", usageMissing: true };

  it.each([
    ["its content is JSON quoting the phrase", completion(JSON.stringify(quoting)), quoting],
    ["its reasoning quotes the phrase", { ...completion('{"a":1}'), choices: [{ index: 0, message: { role: "assistant", content: '{"a":1}', reasoning: `Was ${JSON_MODE_UNMET}? No.` }, finish_reason: "stop" }] }, { a: 1 }],
    ["a string error is a list holding the phrase", { ...completion('{"a":1}'), error: [JSON_MODE_UNMET] }, { a: 1 }],
    ["error.message is a list holding the phrase", { ...completion('{"a":1}'), error: { message: [JSON_MODE_UNMET] } }, { a: 1 }],
    ["an errors[].message is a list holding the phrase", { ...completion('{"a":1}'), errors: [{ message: [JSON_MODE_UNMET] }] }, { a: 1 }],
  ])("reads a 2xx answer normally when %s", async (_name, body, json) => {
    const res = await compatible(fakeFetch([{ status: 200, body }]).fetch).generate(request());
    expect(res).toStrictEqual({ json, model: "@cf/openai/gpt-oss-120b", usage: { inputTokens: 2900, outputTokens: 1300 }, stop: "end" });
  });

  it("keeps a cut-off 2xx answer that quotes the phrase a max_tokens stop", async () => {
    const res = await compatible(fakeFetch([{ status: 200, body: completion(`{"about":"${JSON_MODE_UNMET}`, "length") }]).fetch).generate(request());
    expect(res).toStrictEqual({ json: undefined, model: "@cf/openai/gpt-oss-120b", usage: { inputTokens: 2900, outputTokens: 1300 }, stop: "max_tokens" });
  });

  it.each([
    ["a plain error string", { error: `AiError: ${JSON_MODE_UNMET}` }],
    ["error.message", { error: { message: `AiError: ${JSON_MODE_UNMET}`, type: "invalid_request_error" } }],
    ["a later entry of Cloudflare's errors list", { success: false, errors: [{ code: 1000, message: "Invalid input" }, { code: 1000, message: `AiError: ${JSON_MODE_UNMET}` }] }],
  ])("answers a 2xx whose %s holds the phrase with no JSON", async (_name, body) => {
    expect(await compatible(fakeFetch([{ status: 200, body }]).fetch).generate(request())).toStrictEqual(answered);
  });

  it("answers a 2xx with the phrase in error.message and a usable choice with no JSON, keeping its model and usage", async () => {
    const res = await compatible(fakeFetch([{ status: 200, body: { ...completion('{"a":1}'), error: { message: JSON_MODE_UNMET } } }]).fetch).generate(request());
    expect(res).toStrictEqual({ json: undefined, model: "@cf/openai/gpt-oss-120b", usage: { inputTokens: 2900, outputTokens: 1300 }, stop: "end" });
  });

  it.each([
    ["outside the error fields", { detail: `AiError: ${JSON_MODE_UNMET}` }],
    ["in a choice's content", { choices: [{ message: { content: JSON_MODE_UNMET }, finish_reason: "stop" }] }],
  ])("answers a 400 whose body holds the phrase %s with no JSON", async (_name, body) => {
    expect(await compatible(fakeFetch([{ status: 400, body }]).fetch).generate(request())).toStrictEqual(answered);
  });
});

describe("OpenAICompatibleProvider: error kinds and messages (task 7 additions B and D)", () => {
  const KEY = "gsk-test-key-7"; // lowercase on purpose: it passes the token pattern, so only the key check keeps it out
  const failWith = (status: number, body: unknown) => compatible(fakeFetch([{ status, body }]).fetch, KEY).generate(request());

  it("names the provider's error type and code, never its text or the key", async () => {
    const body = { error: { message: `Invalid API Key ${KEY}`, type: "invalid_request_error", code: "invalid_api_key" } };
    await expect(failWith(401, body)).rejects.toMatchObject({
      name: "ProviderError",
      kind: "auth",
      message: "OpenAI-compatible request failed (auth, HTTP 401, invalid_request_error, invalid_api_key)",
    });
  });

  it("names a code once when the type repeats it", async () => {
    const body = { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } };
    await expect(failWith(402, body)).rejects.toMatchObject({ kind: "auth", message: "OpenAI-compatible request failed (auth, HTTP 402, insufficient_quota)" });
  });

  it.each([
    ["spaces and capitals", { type: "Invalid Request" }],
    ["capitals", { code: "Invalid_API_Key" }],
    ["65 characters", { type: "x".repeat(65) }],
    ["an empty string", { code: "" }],
    ["a line break", { code: "bad\ncode" }],
    ["a number", { code: 42 }],
    ["a list and a null", { type: null, code: ["invalid_api_key"] }],
    ["the key itself", { code: KEY }],
    ["text holding the key", { code: `key_${KEY}_rejected` }],
  ])("leaves out an error type or code with %s", async (_name, fields) => {
    await expect(failWith(400, { error: { message: "m", ...fields } })).rejects.toMatchObject({
      kind: "bad_request",
      message: "OpenAI-compatible request failed (bad_request, HTTP 400)",
    });
  });

  // console.groq.com/docs/spend-limits: "API calls ... will return a 400 with code `blocked_api_access`".
  // The page shows no body; error.code is where Groq's other documented error bodies put a code.
  it("maps Groq's spend cap, a 400 with error.code blocked_api_access, to auth", async () => {
    const body = { error: { message: "Organization spend limit reached", type: "invalid_request_error", code: "blocked_api_access" } };
    await expect(failWith(400, body)).rejects.toMatchObject({
      kind: "auth",
      message: "OpenAI-compatible request failed (auth, HTTP 400, invalid_request_error, blocked_api_access)",
    });
  });

  it.each([
    ["at the top level", { code: "blocked_api_access", error: { message: "m" } }],
    ["in error.type", { error: { type: "blocked_api_access" } }],
    ["in Cloudflare's errors list", { errors: [{ code: "blocked_api_access", message: "m" }] }],
    ["a plain error string", { error: "blocked_api_access" }],
    ["in capitals", { error: { code: "BLOCKED_API_ACCESS" } }],
    ["only in the message", { error: { message: "blocked_api_access" } }],
  ])("keeps a 400 a bad request when blocked_api_access is %s", async (_name, body) => {
    await expect(failWith(400, body)).rejects.toMatchObject({ kind: "bad_request" });
  });

  it.each([
    [429, "rate_limited"],
    [500, "unavailable"],
  ])("maps blocked_api_access to auth only on a 400: HTTP %i stays %s", async (status, kind) => {
    await expect(failWith(status, { error: { code: "blocked_api_access" } })).rejects.toMatchObject({ kind });
  });

  it.each([
    ["the router's plain error string", 402, { error: "You have reached the free monthly usage limit for groq." }, "auth, HTTP 402"],
    ["Cloudflare's errors list", 429, { success: false, errors: [{ code: 3036, message: "you have used up your daily free allocation" }], messages: [], result: null }, "rate_limited, HTTP 429"],
    ["an OpenAI-style error object", 429, { error: { message: "Rate limit reached", type: "tokens", code: "rate_limit_exceeded" } }, "rate_limited, HTTP 429, tokens, rate_limit_exceeded"],
    ["a null body", 503, null, "unavailable, HTTP 503"],
    ["a list body", 400, [{ error: { code: "blocked_api_access" } }], "bad_request, HTTP 400"],
    ["a null error", 400, { error: null }, "bad_request, HTTP 400"],
    ["an error list", 400, { error: [{ code: "blocked_api_access" }] }, "bad_request, HTTP 400"],
    ["an errors string", 429, { errors: "x" }, "rate_limited, HTTP 429"],
  ])("reads %s without throwing", async (_name, status, body, details) => {
    await expect(failWith(status, body)).rejects.toMatchObject({ name: "ProviderError", message: `OpenAI-compatible request failed (${details})` });
  });

  it("maps an error body that is not JSON by its status", async () => {
    const provider = compatible(rawFetch(502, "<html><body>Bad gateway</body></html>", "text/html").fetch, KEY);
    await expect(provider.generate(request())).rejects.toMatchObject({ kind: "unavailable", message: "OpenAI-compatible request failed (unavailable, HTTP 502)" });
  });
});

describe("OpenAICompatibleProvider: usage (task 7 additions C)", () => {
  const answerWith = (usage: unknown) => compatible(fakeFetch([{ status: 200, body: { ...completion('{"a":1}'), usage } }]).fetch).generate(request());

  it("leaves usageMissing out when both counts are usable", async () => {
    expect(await answerWith({ prompt_tokens: 2900, completion_tokens: 1300, total_tokens: 4200 })).toStrictEqual({
      json: { a: 1 },
      model: "@cf/openai/gpt-oss-120b",
      usage: { inputTokens: 2900, outputTokens: 1300 },
      stop: "end",
    });
  });

  it.each([
    ["no usage", undefined, 0, 0],
    ["a null usage", null, 0, 0],
    ["a usage string", "2900", 0, 0],
    ["only prompt_tokens", { prompt_tokens: 2900 }, 2900, 0],
    ["a completion_tokens string", { prompt_tokens: 2900, completion_tokens: "1300" }, 2900, 0],
    ["a negative prompt_tokens", { prompt_tokens: -1, completion_tokens: 1300 }, 0, 1300],
  ])("marks %s with usageMissing and keeps each usable count", async (_name, usage, inputTokens, outputTokens) => {
    expect(await answerWith(usage)).toStrictEqual({ json: { a: 1 }, model: "@cf/openai/gpt-oss-120b", usage: { inputTokens, outputTokens }, stop: "end", usageMissing: true });
  });

  it("keeps a count of 0 as usable", async () => {
    expect(await answerWith({ prompt_tokens: 0, completion_tokens: 0 })).toStrictEqual({ json: { a: 1 }, model: "@cf/openai/gpt-oss-120b", usage: { inputTokens: 0, outputTokens: 0 }, stop: "end" });
  });

  it("marks a count too large to be a finite number", async () => {
    const text = '{"model":"m","choices":[{"message":{"content":"{}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1e400,"completion_tokens":5}}';
    expect(await compatible(rawFetch(200, text).fetch).generate(request())).toStrictEqual({ json: {}, model: "m", usage: { inputTokens: 0, outputTokens: 5 }, stop: "end", usageMissing: true });
  });
});

describe("OpenAICompatibleProvider: a 200 without a usable choice", () => {
  it.each([
    ["null", null],
    ["a list", []],
    ["a string", "text"],
    ["a number", 42],
    ["a null choice", { choices: [null] }],
    ["a number choice", { choices: [1] }],
    ["a string of choices", { choices: "abc" }],
    ["an object of choices", { choices: {} }],
  ])("maps a body that is %s to unavailable", async (_name, body) => {
    await expect(compatible(fakeFetch([{ status: 200, body }]).fetch).generate(request())).rejects.toMatchObject({ name: "ProviderError", kind: "unavailable" });
  });

  it("maps a body that is not JSON to unavailable", async () => {
    await expect(compatible(rawFetch(200, "<html>ok</html>", "text/html").fetch).generate(request())).rejects.toMatchObject({ name: "ProviderError", kind: "unavailable" });
  });

  it("returns no JSON for a cut-off answer, even when its content parses", async () => {
    const res = await compatible(fakeFetch([{ status: 200, body: completion('{"a":1}', "length") }]).fetch).generate(request());
    expect(res).toMatchObject({ json: undefined, stop: "max_tokens" });
  });
});

describe("OpenAICompatibleProvider: a body that cannot be read", () => {
  /** A fetch whose response has this status and a body stream that fails when read. */
  const brokenBody = (status: number) => async (): Promise<Response> =>
    new Response(new ReadableStream({ start: (controller) => controller.error(new TypeError("terminated")) }), { status });

  it.each([
    [200, "unavailable"],
    [401, "auth"],
    [429, "rate_limited"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    await expect(compatible(brokenBody(status)).generate(request())).rejects.toMatchObject({ name: "ProviderError", kind });
  });

  it("maps a 200 whose body read failed after our abort to timeout", async () => {
    await expect(compatible(brokenBody(200)).generate(request(abortedSignal()))).rejects.toMatchObject({ name: "ProviderError", kind: "timeout" });
  });
});

describe("OpenAICompatibleProvider: the request it builds", () => {
  it("sends exactly toWireSchema(jsonSchema) as the schema, the text inputBound measures", async () => {
    const http = rawFetch(200, JSON.stringify(completion("{}")));
    await compatible(http.fetch).generate(request());
    expect(http.bodies).toHaveLength(1);
    expect(http.bodies[0]).toContain(`"json_schema":{"name":"site_draft","strict":true,"schema":${JSON.stringify(toWireSchema(AI_DRAFT_JSON_SCHEMA))}}`);
  });

  it.each([
    ["a schema toWireSchema refuses", { type: "object", patternProperties: {} }, 'toWireSchema: unsupported JSON schema keyword "patternProperties"'],
    ["a body JSON.stringify cannot write", { type: "object", enum: [{ toJSON: () => { throw new Error("our own bug"); } }] }, "our own bug"],
  ])("lets an error from our own request building propagate for %s, and sends nothing", async (_name, jsonSchema, message) => {
    const http = fakeFetch([]);
    const error: unknown = await compatible(http.fetch).generate({ ...request(), jsonSchema }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ProviderError);
    expect((error as Error).message).toBe(message);
    expect(http.calls).toHaveLength(0);
  });

  it("never lets the model's extra fields replace the adapter's own", async () => {
    // MODELS has no colliding entry (models.test.ts pins that), so the test adds one and removes it.
    const table = MODELS as Record<string, ModelSettings>;
    const key = "openai-compatible:test/collides";
    table[key] = { price: table["fake:fake-template"]!.price, extraBody: { model: "other", messages: [], max_tokens: 1, response_format: { type: "text" }, top_k: 5 } };
    try {
      const http = fakeFetch([{ status: 200, body: completion("{}") }]);
      await new OpenAICompatibleProvider({ baseUrl: WORKERS_AI, apiKey: "k", model: "test/collides", fetch: http.fetch }).generate(request());
      expect(http.calls[0]!.body).toEqual({
        top_k: 5,
        model: "test/collides",
        messages: [
          { role: "system", content: "SYS" },
          { role: "user", content: "USER" },
        ],
        max_tokens: 8192,
        response_format: { type: "json_schema", json_schema: { name: "site_draft", strict: true, schema: toWireSchema(AI_DRAFT_JSON_SCHEMA) } },
      });
    } finally {
      delete table[key];
    }
  });
});
