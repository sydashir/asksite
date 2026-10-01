import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "../src/providers/create.ts";
import { AI_DRAFT_JSON_SCHEMA } from "../src/wire-schema.ts";
import { fakeFetch } from "./support/http.ts";
import { FULL_SNAPSHOT } from "./support/samples.ts";

const base = { ENVIRONMENT: "development", MODEL_ID: "m" };

// No test in this file may reach the network, even when a mutant drops the fetch we inject: the SDK takes the global
// fetch when it is built without one (client.mjs:113), and this global fails loudly instead.
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

  // The fake provider needs no key and costs nothing, so it must fail closed: only the exact, case-sensitive values
  // "development" and "test" build it; anything else, a typo included, refuses it without echoing the value.
  it.each(["development", "test"])("builds the fake provider when ENVIRONMENT is %j", (environment) => {
    expect(createProvider({ ...base, ENVIRONMENT: environment, MODEL_PROVIDER: "fake" }, FULL_SNAPSHOT).id).toBe("fake");
  });

  it.each(["production", "Production", " production", "prod", "", "Development", "TEST", "development ", "staging"])(
    "refuses the fake provider when ENVIRONMENT is %j",
    (environment) => {
      expect(() => createProvider({ ...base, ENVIRONMENT: environment, MODEL_PROVIDER: "fake" }, FULL_SNAPSHOT)).toThrow(
        expect.objectContaining({ name: "ProviderError", kind: "bad_request" }),
      );
    },
  );

  it("does not echo the ENVIRONMENT value in the refusal", () => {
    expect(() => createProvider({ ...base, ENVIRONMENT: "env-marker-7", MODEL_PROVIDER: "fake" }, FULL_SNAPSHOT)).toThrow(
      expect.objectContaining({ kind: "bad_request", message: expect.not.stringContaining("env-marker-7") }),
    );
  });

  it("refuses the fake provider when ENVIRONMENT is missing", () => {
    const { ENVIRONMENT: _omitted, ...withoutEnvironment } = base;
    expect(() => createProvider({ ...withoutEnvironment, MODEL_PROVIDER: "fake" } as unknown as Parameters<typeof createProvider>[0], FULL_SNAPSHOT)).toThrow(
      expect.objectContaining({ name: "ProviderError", kind: "bad_request" }),
    );
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

const REQ = { system: "s", user: "u", jsonSchema: AI_DRAFT_JSON_SCHEMA, maxOutputTokens: 10, signal: new AbortController().signal };
const COMPAT_ANSWER = { model: "m", choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
const ANTHROPIC_ANSWER = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "m",
  content: [{ type: "text", text: "{}" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};
const COMPAT_ENV = { MODEL_PROVIDER: "openai-compatible", OPENAI_COMPAT_BASE_URL: "https://x.example/v1", OPENAI_COMPAT_API_KEY: "k" };
const ANTHROPIC_ENV = { MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" };

// P3-11 (s): Task 7 review survivors X12, X13, X15 and X16, pinned.
describe("createProvider: wiring (P3-11 s)", () => {
  it.each([
    ["openai-compatible", COMPAT_ENV, COMPAT_ANSWER],
    ["anthropic", ANTHROPIC_ENV, ANTHROPIC_ANSWER],
  ])("sends MODEL_ID as the %s request's model (X12, X13)", async (_name, env, answer) => {
    const http = fakeFetch([{ status: 200, body: answer }]);
    await createProvider({ ...base, ...env, MODEL_ID: "model-id-under-test" }, FULL_SNAPSHOT, http.fetch).generate(REQ);
    expect(http.calls.map((c) => c.body.model)).toEqual(["model-id-under-test"]);
  });

  it("sends the Anthropic request through the fetch it is given, never the global one (X15)", async () => {
    const http = fakeFetch([{ status: 200, body: ANTHROPIC_ANSWER }]);
    await createProvider({ ...base, ...ANTHROPIC_ENV }, FULL_SNAPSHOT, http.fetch).generate(REQ);
    expect(http.calls).toHaveLength(1);
    expect(globalFetchCalls).toHaveLength(0);
  });

  it.each([
    ["error", "unavailable"],
    ["timeout", "timeout"],
  ])("builds the fake provider in FAKE_MODE %s, which fails as %s (X16)", async (mode, kind) => {
    await expect(createProvider({ ...base, MODEL_PROVIDER: "fake", FAKE_MODE: mode }, FULL_SNAPSHOT).generate(REQ)).rejects.toMatchObject({ name: "ProviderError", kind });
  });

  it("builds the fake provider in FAKE_MODE ok when FAKE_MODE is not set", async () => {
    await expect(createProvider({ ...base, MODEL_PROVIDER: "fake" }, FULL_SNAPSHOT).generate(REQ)).resolves.toMatchObject({ model: "fake-template", stop: "end" });
  });
});

// P3-11 (s), KEY CROSSING (moderator: "that one matters"): two distinct marker keys, never real ones. Each request
// carries its own provider's key where it belongs, and the other key nowhere: not in any header value, the URL or
// the body.
describe("createProvider: keys never cross providers (P3-11 s)", () => {
  const ANTHROPIC_MARKER = "anthropic-marker-key-A1";
  const COMPAT_MARKER = "compat-marker-key-B2";
  const bothKeys = { ...base, ANTHROPIC_API_KEY: ANTHROPIC_MARKER, OPENAI_COMPAT_API_KEY: COMPAT_MARKER, OPENAI_COMPAT_BASE_URL: "https://x.example/v1" };

  /** A fetch that records each request's URL, every header and the body text, and answers with `body`. */
  const recorder = (body: unknown) => {
    const seen: Array<{ url: string; headers: Array<[string, string]>; body: string }> = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      seen.push({ url: request.url, headers: [...request.headers], body: await request.text() });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    return { fetch, seen };
  };

  it("sends the compatible key as its Bearer token and the Anthropic key nowhere (X14)", async () => {
    const http = recorder(COMPAT_ANSWER);
    await createProvider({ ...bothKeys, MODEL_PROVIDER: "openai-compatible" }, FULL_SNAPSHOT, http.fetch).generate(REQ);
    expect(http.seen).toHaveLength(1);
    const sent = http.seen[0]!;
    expect(new URL(sent.url).host).toBe("x.example");
    expect(new Headers(sent.headers).get("authorization")).toBe(`Bearer ${COMPAT_MARKER}`);
    for (const text of [sent.url, sent.body, ...sent.headers.flat()]) expect(text).not.toContain(ANTHROPIC_MARKER);
  });

  it("sends the Anthropic key as its x-api-key and the compatible key nowhere (mirror of X14)", async () => {
    const http = recorder(ANTHROPIC_ANSWER);
    await createProvider({ ...bothKeys, MODEL_PROVIDER: "anthropic" }, FULL_SNAPSHOT, http.fetch).generate(REQ);
    expect(http.seen).toHaveLength(1);
    const sent = http.seen[0]!;
    expect(new URL(sent.url).host).toBe("api.anthropic.com");
    expect(new Headers(sent.headers).get("x-api-key")).toBe(ANTHROPIC_MARKER);
    for (const text of [sent.url, sent.body, ...sent.headers.flat()]) expect(text).not.toContain(COMPAT_MARKER);
  });
});
