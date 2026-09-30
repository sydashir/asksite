import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createTestHarness } from "wrangler";

it("runs both model adapters inside workerd (compatibility date 2026-09-21, no nodejs_compat)", async () => {
  const server = createTestHarness({
    root: fileURLToPath(new URL("../../../", import.meta.url)),
    workers: [{ config: { name: "adapters-in-workerd", main: "./apps/generator/test/support/adapters-worker.ts", compatibility_date: "2026-09-21" } }],
  });
  try {
    await server.listen();
    expect(await (await server.fetch("/")).json()).toEqual({
      anthropic: { json: { ok: true }, model: "claude-opus-5-5", usage: { inputTokens: 1, outputTokens: 2 }, stop: "end" },
      compatible: { json: { ok: true }, model: "m", usage: { inputTokens: 3, outputTokens: 4 }, stop: "end" },
      seen: ["POST https://api.anthropic.com/v1/messages", "POST https://api.example.com/v1/chat/completions"],
    });
  } finally {
    await server.close();
  }
}, 120_000);
