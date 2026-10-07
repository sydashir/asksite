import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";

// The test Worker's /__test/delete-owner runs the REAL deleteOwner, which needs the LIVE bucket the production app does not bind. Where LIVE is not
// bound (the e2e config shares test/support/test-worker.ts), the seam must fail closed: answer 500 and run nothing. This is the test config without its LIVE binding.
const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const base = JSON.parse(readFileSync(new URL("../wrangler.test.jsonc", import.meta.url), "utf8")) as {
  d1_databases: Array<Record<string, unknown>>;
  r2_buckets: Array<{ binding: string; bucket_name: string }>;
} & Record<string, unknown>;
const config = {
  ...base,
  name: "asksite-app-test-no-live",
  main: here("../support/test-worker.ts"),
  d1_databases: base.d1_databases.map((d) => ({ ...d, migrations_dir: here("../../../../packages/core/migrations") })),
  r2_buckets: base.r2_buckets.filter((bucket) => bucket.binding !== "LIVE"),
};
const server = createTestHarness({ root: here("../../../.."), workers: [{ config }] });

beforeAll(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
}, 120_000);
afterAll(async () => {
  await server.close();
});

describe("/__test/delete-owner without a LIVE binding", () => {
  it("is configured without one", async () => {
    expect(config.r2_buckets.map((b) => b.binding)).toEqual(["WORK", "MEDIA"]);
    expect("LIVE" in ((await server.getWorker().getEnv()) as Record<string, unknown>)).toBe(false);
  });

  it("fails closed: 500 no_live_binding, before it reads the body or touches the database", async () => {
    // A body that is not JSON: only a seam that checks LIVE first answers with its own error instead of a parse failure.
    const res = await server.fetch("https://app.localhost:8787/__test/delete-owner", { method: "POST", body: "not json" });
    expect([res.status, await res.json()]).toEqual([500, { error: "no_live_binding" }]);
  });
});
