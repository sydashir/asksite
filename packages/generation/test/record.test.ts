import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureName, recordingFetch } from "../eval/record.ts";
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
