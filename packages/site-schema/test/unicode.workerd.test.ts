import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { UNICODE_17 } from "./support/unicode-version.ts";

// Production checks copy inside workerd, whose V8 brings its own Unicode data. So copy.test.ts's Unicode tripwire runs
// here too (A9d): a workerd upgrade to another Unicode version fails this test and is reviewed first.
const WORKER = {
  name: "unicode-probe",
  main: "packages/site-schema/test/support/unicode-probe.ts",
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

/** What unicode-probe.ts answers. */
type Probe = { unicode: unknown; process: unknown };
const probe = async (): Promise<Probe> => (await (await server.fetch("https://probe.localhost/")).json()) as Probe;

describe("inside workerd", () => {
  it("runs on the Unicode version the letter tables were derived from (17.0), so an upgrade is reviewed first", async () => {
    expect((await probe()).unicode).toEqual(UNICODE_17);
  });

  it("opts out of Node.js compatibility and sets no flag starting with nodejs (A13)", () => {
    expect(WORKER.compatibility_flags).toEqual(expect.arrayContaining(["no_nodejs_compat", "no_nodejs_compat_v2"]));
    expect(WORKER.compatibility_flags.filter((flag) => flag.startsWith("nodejs"))).toEqual([]);
  });

  it("runs without Node.js's process (A13)", async () => {
    expect((await probe()).process).toBe("undefined");
  });
});
