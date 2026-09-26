import { describe, expect, it } from "vitest";
import { createProvider } from "../src/providers/create.ts";
import { AI_DRAFT_JSON_SCHEMA } from "../src/wire-schema.ts";
import { fakeFetch } from "./support/http.ts";
import { FULL_SNAPSHOT } from "./support/samples.ts";

const base = { ENVIRONMENT: "development", MODEL_ID: "m" };

describe("createProvider", () => {
  it("builds the provider MODEL_PROVIDER names", () => {
    expect(createProvider({ ...base, MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }, FULL_SNAPSHOT).id).toBe("anthropic");
    expect(createProvider({ ...base, MODEL_PROVIDER: "openai-compatible", OPENAI_COMPAT_BASE_URL: "https://router.huggingface.co/v1", OPENAI_COMPAT_API_KEY: "k" }, FULL_SNAPSHOT).id).toBe("openai-compatible");
    expect(createProvider({ ...base, MODEL_PROVIDER: "fake", FAKE_MODE: "invalid-once" }, FULL_SNAPSHOT).id).toBe("fake");
  });

  it("sends through the fetch it is given", async () => {
    const http = fakeFetch([{ status: 200, body: { model: "m", choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }]);
    const env = { ...base, MODEL_PROVIDER: "openai-compatible", OPENAI_COMPAT_BASE_URL: "https://x.example/v1", OPENAI_COMPAT_API_KEY: "k" };
    await createProvider(env, FULL_SNAPSHOT, http.fetch).generate({ system: "s", user: "u", jsonSchema: AI_DRAFT_JSON_SCHEMA, maxOutputTokens: 10, signal: new AbortController().signal });
    expect(http.calls.map((c) => c.url)).toEqual(["https://x.example/v1/chat/completions"]);
  });

  it.each([
    [{ MODEL_PROVIDER: "anthropic" }, "auth"],
    [{ MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "" }, "auth"],
    [{ MODEL_PROVIDER: "openai-compatible", OPENAI_COMPAT_BASE_URL: "https://x.example/v1" }, "auth"],
    [{ MODEL_PROVIDER: "openai-compatible", OPENAI_COMPAT_API_KEY: "k" }, "bad_request"],
    [{ MODEL_PROVIDER: "openai-compatible", OPENAI_COMPAT_API_KEY: "k", OPENAI_COMPAT_BASE_URL: "http://x.example/v1" }, "bad_request"],
    [{ MODEL_PROVIDER: "fake", FAKE_MODE: "sometimes" }, "bad_request"],
    [{ MODEL_PROVIDER: "fake", ENVIRONMENT: "production" }, "bad_request"],
    [{ MODEL_PROVIDER: "gpt" }, "bad_request"],
    [{ MODEL_PROVIDER: "openai-compatible", OPENAI_COMPAT_BASE_URL: "https://x.example/v1", OPENAI_COMPAT_API_KEY: "" }, "auth"],
    [{ MODEL_PROVIDER: "openai-compatible", OPENAI_COMPAT_BASE_URL: "", OPENAI_COMPAT_API_KEY: "k" }, "bad_request"],
  ])("refuses a bad configuration %o with a %s ProviderError", (env, kind) => {
    expect(() => createProvider({ ...base, ...env }, FULL_SNAPSHOT)).toThrow(expect.objectContaining({ name: "ProviderError", kind }));
  });

  // Review survivor C4: a missing or empty base URL is named as not set, not as a URL that is not https.
  it.each([
    ["a missing", {}],
    ["an empty", { OPENAI_COMPAT_BASE_URL: "" }],
  ])("names %s OPENAI_COMPAT_BASE_URL as not set", (_name, url) => {
    expect(() => createProvider({ ...base, MODEL_PROVIDER: "openai-compatible", OPENAI_COMPAT_API_KEY: "k", ...url }, FULL_SNAPSHOT)).toThrow(
      expect.objectContaining({ name: "ProviderError", kind: "bad_request", message: "OPENAI_COMPAT_BASE_URL is not set" }),
    );
  });

  it("refuses a base URL with a query through createProvider too (P3-11 u)", () => {
    const env = { ...base, MODEL_PROVIDER: "openai-compatible", OPENAI_COMPAT_API_KEY: "k", OPENAI_COMPAT_BASE_URL: "https://x.example/v1?" };
    expect(() => createProvider(env, FULL_SNAPSHOT)).toThrow(expect.objectContaining({ name: "ProviderError", kind: "bad_request" }));
  });

  // P3-11 (k): a key an HTTP header cannot carry as typed is refused at setup as auth, before any request.
  const newline = String.fromCharCode(10);
  it.each([
    ["an Anthropic key of spaces", { MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "   " }],
    ["an Anthropic key with a newline", { MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: `sk-ant-a${newline}b` }],
    ["a compatible key of spaces", { MODEL_PROVIDER: "openai-compatible", OPENAI_COMPAT_BASE_URL: "https://x.example/v1", OPENAI_COMPAT_API_KEY: "   " }],
    ["a compatible key with a trailing newline", { MODEL_PROVIDER: "openai-compatible", OPENAI_COMPAT_BASE_URL: "https://x.example/v1", OPENAI_COMPAT_API_KEY: `gsk-a${newline}` }],
  ])("refuses %s as auth, with no request", (_name, env) => {
    const http = fakeFetch([]);
    expect(() => createProvider({ ...base, ...env }, FULL_SNAPSHOT, http.fetch)).toThrow(expect.objectContaining({ name: "ProviderError", kind: "auth" }));
    expect(http.calls).toHaveLength(0);
  });

  // In Node the SDK reads process.env.ANTHROPIC_API_KEY when apiKey is undefined (Task 6 review), so a
  // missing key must be refused here, never left for the SDK to fill in.
  it.each([
    ["missing", {}],
    ["empty", { ANTHROPIC_API_KEY: "" }],
  ])("refuses a %s Anthropic key even when the process environment holds one", (_name, key) => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-dummy-from-env";
    try {
      expect(() => createProvider({ ...base, MODEL_PROVIDER: "anthropic", ...key }, FULL_SNAPSHOT)).toThrow(expect.objectContaining({ name: "ProviderError", kind: "auth" }));
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
