import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publishingHarness } from "./support/harness.ts";

// A13: at compatibility date 2026-09-21 Node.js compatibility is ON by default (and fills process.env
// with every text binding, secrets included). The harness turns it off, as production does, so every
// publishing test runs the runtime production runs.
const harness = publishingHarness("publishing-runtime-test");
beforeAll(async () => {
  await harness.start();
}, 120_000);
afterAll(async () => {
  await harness.server.close();
});

describe("the publishing harness Worker (A13)", () => {
  it("has no Node.js process global and no node:* modules", async () => {
    const response = await harness.server.fetch("/");
    expect(await response.json()).toEqual({ process: "undefined", nodeBuffer: "absent" });
  });
});
