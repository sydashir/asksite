import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findRequestSecret, fixtureName, recordingFetch, type RequestHeader } from "../eval/record.ts";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.ts";
import { AI_DRAFT_JSON_SCHEMA } from "../src/wire-schema.ts";
import { fakeFetch } from "./support/http.ts";

// No test in this file may reach the network, even when a mutant drops the fetch we inject (global-constraints L): the
// adapter falls back to the global fetch when it is built without one, and this global fails loudly instead.
const globalFetchCalls: unknown[] = [];
beforeEach(() => {
  globalFetchCalls.length = 0;
  vi.stubGlobal("fetch", async (...args: unknown[]) => {
    globalFetchCalls.push(args);
    throw new TypeError("the global fetch must not be used");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(globalFetchCalls).toEqual([]);
});

describe("recordingFetch", () => {
  it("keeps each response's status and body, never the request, and leaves the response readable", async () => {
    const body = { model: "m", choices: [{ message: { content: '{"a":1}' }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 6 } };
    const sink: Array<{ status: number; body: unknown }> = [];
    const provider = new OpenAICompatibleProvider({ baseUrl: "https://x.example/v1", apiKey: "secret-key-1", model: "m", fetch: recordingFetch(fakeFetch([{ status: 200, body }]).fetch, sink) });
    const res = await provider.generate({ system: "s", user: "u", jsonSchema: AI_DRAFT_JSON_SCHEMA, maxOutputTokens: 10, signal: new AbortController().signal });
    expect(res.json).toEqual({ a: 1 });
    expect(sink).toEqual([{ status: 200, body }]);
    expect(JSON.stringify(sink)).not.toContain("secret-key-1");
  });
});

describe("fixtureName", () => {
  it("turns a label into a safe file name", () => {
    expect(fixtureName("workers-ai/gpt-oss-120b")).toBe("workers-ai__gpt-oss-120b.json");
    expect(fixtureName("claude-opus-5-5")).toBe("claude-opus-5-5.json");
    expect(fixtureName("../../etc")).toBe("..__..__etc.json");
  });
});

const KEY = "sk-test-marker-0123456789abcdef";
const TOKEN = "hdr-test-marker-token-987654";
/** What the recorder would see for a typical request: the key's headers plus the SDK's short values. */
const HEADERS: RequestHeader[] = [
  ["authorization", `Bearer ${TOKEN}`],
  ["x-api-key", KEY],
  ["anthropic-version", "2023-06-01"],
  ["x-stainless-retry-count", "0"],
  ["x-stainless-timeout", "90"],
  ["content-type", "application/json"],
  ["accept", "application/json"],
  ["user-agent", "Anthropic/JS 0.128.0"],
];
const fixtureText = (body: unknown, status = 200): string => JSON.stringify({ provider: "anthropic", modelId: "m", status, body }, null, 2);

describe("findRequestSecret (rule 1: a key or auth value; rule 2: a header name)", () => {
  it.each([
    ["the API key value", fixtureText({ echo: `key ${KEY}` }), 1, "API key"],
    ["the x-api-key value, with no key given", fixtureText({ echo: KEY }), 1, "x-api-key"],
    ["a Bearer-stripped token", fixtureText({ echo: TOKEN }), 1, "authorization"],
    ["the whole Bearer value", fixtureText({ echo: `Bearer ${TOKEN}` }), 1, "authorization"],
    ["an x-api-key header name", fixtureText({ echo: "the x-api-key header" }), 2, "x-api-key"],
    ["an X-Api-Key header name in another case", fixtureText({ echo: "X-API-KEY: nope" }), 2, "x-api-key"],
    ["an authorization key in the body", fixtureText({ Authorization: "x" }), 2, "authorization"],
    ["anthropic-version", fixtureText({ echo: "anthropic-version: 2023-06-01" }), 2, "anthropic-version"],
    ["an x-stainless header name", fixtureText({ echo: "x-stainless-retry-count" }), 2, "x-stainless-retry-count"],
  ])("refuses %s", (_name, text, rule, name) => {
    expect(findRequestSecret(text, HEADERS, name === "API key" ? KEY : undefined)).toEqual({ rule, name });
  });

  it("accepts a clean fixture with status 200 and token counts of 90 and 0", () => {
    const text = fixtureText({ usage: { input_tokens: 90, output_tokens: 0 }, content: [{ text: "We are authorized plumbers, with a great key to the city." }] });
    expect(findRequestSecret(text, HEADERS, KEY)).toBeNull();
    expect(text).toContain('"status": 200');
  });

  it("matches a header name as a whole token: authorized is not authorization", () => {
    expect(findRequestSecret(fixtureText({ t: "Authorized and authorizations? no: authorized" }), HEADERS, KEY)).toBeNull();
    expect(findRequestSecret(fixtureText({ t: "an authorization is needed" }), HEADERS, KEY)).toEqual({ rule: 2, name: "authorization" });
  });

  it("checks the value of any header whose name holds key, token, secret or auth, and of cookie and proxy-authorization", () => {
    for (const name of ["x-my-key", "x-session-token", "x-client-secret", "x-auth-mode", "cookie", "proxy-authorization"]) {
      expect(findRequestSecret(fixtureText({ echo: "value-abc-123" }), [[name, "value-abc-123"]], undefined)).toMatchObject({ rule: 1, name });
    }
    expect(findRequestSecret(fixtureText({ echo: "value-abc-123" }), [["x-other", "value-abc-123"]], undefined)).toBeNull();
  });

  it("allows the generic accept, content-type and user-agent names", () => {
    expect(findRequestSecret(fixtureText({ t: "accept content-type user-agent" }), HEADERS, KEY)).toBeNull();
  });
});

describe("recordingFetch keeps the request headers in memory, apart from the fixture", () => {
  it("collects both adapters' real request headers, and none of them reaches the fixture text", async () => {
    const openaiBody = { model: "m", choices: [{ message: { content: '{"a":1}' }, finish_reason: "stop" }], usage: { prompt_tokens: 90, completion_tokens: 0 } };
    const anthropicBody = { id: "msg_1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: '{"a":1}' }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 90, output_tokens: 0 } };
    const request = { system: "s", user: "u", jsonSchema: AI_DRAFT_JSON_SCHEMA, maxOutputTokens: 10, signal: new AbortController().signal };
    const openaiSink: Array<{ status: number; body: unknown }> = [];
    const openaiSeen: RequestHeader[] = [];
    await new OpenAICompatibleProvider({ baseUrl: "https://x.invalid/v1", apiKey: KEY, model: "m", fetch: recordingFetch(fakeFetch([{ status: 200, body: openaiBody }]).fetch, openaiSink, openaiSeen) }).generate(request);
    const anthropicSink: Array<{ status: number; body: unknown }> = [];
    const anthropicSeen: RequestHeader[] = [];
    await new AnthropicProvider({ apiKey: KEY, model: "m", fetch: recordingFetch(fakeFetch([{ status: 200, body: anthropicBody }]).fetch, anthropicSink, anthropicSeen) }).generate(request);
    expect(openaiSeen).toContainEqual(["authorization", `Bearer ${KEY}`]);
    expect(anthropicSeen).toContainEqual(["x-api-key", KEY]);
    expect(anthropicSeen.map(([name]) => name)).toContain("anthropic-version");
    for (const [sink, seen] of [[openaiSink, openaiSeen], [anthropicSink, anthropicSeen]] as const) {
      const text = fixtureText(sink[0]!.body, sink[0]!.status);
      expect(findRequestSecret(text, seen, KEY)).toBeNull();
      expect(text).not.toContain(KEY);
      expect(text.toLowerCase()).not.toMatch(/authorization|x-api-key|anthropic-version|x-stainless|bearer/);
      expect(JSON.stringify(sink)).not.toMatch(/authorization|x-api-key|x-stainless/i);
    }
  });
});
