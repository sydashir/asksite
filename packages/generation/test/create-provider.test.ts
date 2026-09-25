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
