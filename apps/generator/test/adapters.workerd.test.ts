import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestHarness } from "wrangler";

const WORKER = {
  name: "adapters-in-workerd",
  main: "./apps/generator/test/support/adapters-worker.ts",
  compatibility_date: "2026-09-21",
  compatibility_flags: ["no_nodejs_compat", "no_nodejs_compat_v2"], // A13
};
const server = createTestHarness({ root: fileURLToPath(new URL("../../../", import.meta.url)), workers: [{ config: WORKER }] });

beforeAll(async () => {
  await server.listen();
}, 120_000);
afterAll(async () => server.close());

// Every outbound request of the probe Worker reaches this process's global fetch (wrangler 4.138.0,
// wrangler-dist/cli.js:368848-368850: `outboundService: (request) => globalThis.fetch(request.url, request)`). The probe
// answers both adapters with its own stand-in, so nothing may arrive here: this recorder notes the URL of anything that
// does and refuses it (global-constraints L).
const outbound: string[] = [];
beforeEach(() => {
  outbound.length = 0;
  vi.stubGlobal("fetch", async (input: unknown) => {
    outbound.push(String(input));
    throw new TypeError("adapters probe: unexpected outbound request");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("opts out of Node.js compatibility and sets no flag starting with nodejs (A13)", () => {
  expect(WORKER.compatibility_flags).toEqual(expect.arrayContaining(["no_nodejs_compat", "no_nodejs_compat_v2"]));
  expect(WORKER.compatibility_flags.filter((flag) => flag.startsWith("nodejs"))).toEqual([]);
});

it("runs the adapters without Node.js's process (A13)", async () => {
  expect(await (await server.fetch("/process")).text()).toBe("undefined");
  expect(outbound).toEqual([]);
});

it("runs both model adapters inside workerd (compatibility date 2026-09-21, no nodejs_compat)", async () => {
  expect(await (await server.fetch("/")).json()).toEqual({
    anthropic: { json: { ok: true }, model: "claude-opus-5-5", usage: { inputTokens: 1, outputTokens: 2 }, stop: "end" },
    compatible: { json: { ok: true }, model: "m", usage: { inputTokens: 3, outputTokens: 4 }, stop: "end" },
    seen: ["POST https://api.anthropic.com/v1/messages", "POST https://api.example.com/v1/chat/completions"],
  });
  expect(outbound).toEqual([]);
});
