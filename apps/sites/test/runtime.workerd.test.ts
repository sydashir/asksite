import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { ROOT, TEST_VARS } from "./support/harness.ts";

// A13: at compatibility date 2026-09-21 Node.js compatibility is ON by default (and fills process.env
// with every text binding, secrets included); apps/sites/wrangler.jsonc turns it off. The Worker's main
// module may export only handlers and its router has no test route, so this runs the sites handler inside
// a probe Worker (support/runtime-worker.ts) with the compatibility date and flags read from that file.
const REPO = resolve(import.meta.dirname, "../../..");
const SITES_CONFIG = JSON.parse(readFileSync(resolve(REPO, "apps/sites/wrangler.jsonc"), "utf8")) as {
  compatibility_date: string;
  compatibility_flags?: string[];
};

const server = createTestHarness({
  root: REPO,
  workers: [
    {
      config: {
        name: "asksite-sites-runtime",
        main: "apps/sites/test/support/runtime-worker.ts",
        compatibility_date: SITES_CONFIG.compatibility_date,
        compatibility_flags: SITES_CONFIG.compatibility_flags ?? [],
        vars: TEST_VARS,
      },
    },
  ],
});
beforeAll(async () => {
  await server.listen();
}, 120_000);
afterAll(async () => {
  await server.close();
});

describe("the sites Worker's runtime (A13)", () => {
  it("has no Node.js process global and no node:* modules", async () => {
    const response = await server.fetch(`https://${ROOT}/__runtime`);
    expect(await response.json()).toEqual({ process: "undefined", nodeBuffer: "absent" });
  });

  it("is the runtime the sites handler runs in", async () => {
    const response = await server.fetch(`https://${ROOT}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<h1>Websites for local trades</h1>");
  });
});
