import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "wrangler";
import { PROBE_BASE_URL, PROBE_KEY, PROBE_MODEL } from "./support/compat-probe.ts";

// P3-16 fix 2, the receiver rule. workerd's fetch is a method of the global scope (`JSG_METHOD(fetch)` in
// ServiceWorkerGlobalScope, workerd src/workerd/api/global-scope.h), registered with a V8 signature ("Signatures protect
// our methods from being invoked with the wrong `this`", src/workerd/jsg/resource.h). So it runs when `this` is the
// global scope, or undefined, which V8 replaces with the global scope (v8 src/builtins/builtins-api.cc: "Do proper
// receiver conversion for non-strict mode api functions", and IsCompatibleReceiver accepts the global proxy).
// Any other `this`, such as the object in `holder.fetch(...)` or `this.#fetch(...)`, fails the signature check:
// "TypeError: Illegal invocation: function called with incorrect `this` reference"
// (developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors). The premise row below proves
// the method call fails; the main row proves a call with no receiver works. The OpenAI-compatible adapter keeps the
// fetch it is given in a field, so it calls it with no receiver, or a caller that injects the runtime's own fetch gets
// an outage on every attempt. The probe Worker builds the adapter inside workerd with `fetch: fetch`.
const WORKER = {
  name: "compat-fetch-probe",
  main: "packages/generation/test/support/compat-fetch-worker.ts",
  compatibility_date: "2026-09-21",
  compatibility_flags: ["no_nodejs_compat", "no_nodejs_compat_v2"], // A13
};
const server = createTestHarness({ root: resolve(import.meta.dirname, "../../.."), workers: [{ config: WORKER }] });

beforeAll(async () => {
  await server.listen();
}, 120_000);
afterAll(async () => {
  await server.close();
});

// The harness hands every outbound request of the Worker to this process's global fetch (wrangler 4.138.0,
// wrangler-dist/cli.js:368848-368850: `outboundService: (request) => globalThis.fetch(request.url, request)`). Each test
// replaces that global with a recorder that answers only the adapter's own URL, with a Chat Completions answer, and
// throws for anything else, so no request can leave the machine (the host is .invalid in any case).
const CHAT_URL = `${PROBE_BASE_URL}/chat/completions`;
const ANSWER = { model: "served-model", choices: [{ index: 0, message: { role: "assistant", content: '{"a":1}' }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4 } };
type Outbound = { url: string; method: string; authorization: string | null; body: unknown };
const outbound: Outbound[] = [];
beforeEach(() => {
  outbound.length = 0;
  vi.stubGlobal("fetch", async (input: unknown, init?: Request) => {
    const url = String(input);
    outbound.push({ url, method: init?.method ?? "", authorization: init?.headers.get("authorization") ?? null, body: url === CHAT_URL ? await init?.json() : null });
    if (url !== CHAT_URL) throw new TypeError(`compat fetch probe: unexpected outbound request to ${url}`);
    return Response.json(ANSWER);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the probe Worker (A13)", () => {
  it("opts out of Node.js compatibility and sets no flag starting with nodejs", () => {
    expect(WORKER.compatibility_flags).toEqual(expect.arrayContaining(["no_nodejs_compat", "no_nodejs_compat_v2"]));
    expect(WORKER.compatibility_flags.filter((flag) => flag.startsWith("nodejs"))).toEqual([]);
  });

  it("runs without Node.js's process", async () => {
    expect(await (await server.fetch("https://probe.localhost/process")).text()).toBe("undefined");
  });
});

describe("OpenAICompatibleProvider inside workerd with the runtime's own fetch injected (P3-16 fix 2)", () => {
  it("premise: the runtime's fetch called as a method of another object fails with Illegal invocation, before any request", async () => {
    expect(await (await server.fetch("https://probe.localhost/method-call")).text()).toMatch(/^TypeError: Illegal invocation/);
    expect(outbound).toEqual([]);
  });

  it("sends the request through that fetch and returns the answer: no Illegal invocation", async () => {
    const result: unknown = await (await server.fetch("https://probe.localhost/")).json();
    expect(result).toEqual({ answer: { json: { a: 1 }, model: "served-model", usage: { inputTokens: 3, outputTokens: 4 }, stop: "end" } });
    expect(outbound).toEqual([{ url: CHAT_URL, method: "POST", authorization: `Bearer ${PROBE_KEY}`, body: expect.objectContaining({ model: PROBE_MODEL }) }]);
  });
});
