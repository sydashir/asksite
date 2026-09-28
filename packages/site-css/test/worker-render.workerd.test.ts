import { resolve } from "node:path";
import { render } from "@asksite/renderer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { FIXTURES, loadFixture } from "../../../fixtures/index.ts";
import { SITE_CSS } from "../src/index.ts";
import { PROBE_FORM_ACTION } from "./support/probe-form-action.ts";

// Proves the Worker bundle: wrangler (esbuild) bundles @asksite/renderer, zod and the generated
// stylesheet, and workerd renders every fixture byte-for-byte like Node does.
const WORKER = {
  name: "render-probe",
  main: "packages/site-css/test/support/render-probe.ts",
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

// A13: from compatibility date 2026-08-04 Workers turn nodejs_compat and nodejs_compat_v2 on by default, so the harness
// opts out of both, and no flag starting with "nodejs" (such as nodejs_compat_populate_process_env) may come back.
describe("the harness Worker (A13)", () => {
  it("opts out of Node.js compatibility and sets no flag starting with nodejs", () => {
    expect(WORKER.compatibility_flags).toEqual(expect.arrayContaining(["no_nodejs_compat", "no_nodejs_compat_v2"]));
    expect(WORKER.compatibility_flags.filter((flag) => flag.startsWith("nodejs"))).toEqual([]);
  });

  it("runs without Node.js's process", async () => {
    expect(await (await server.fetch("https://probe.localhost/process")).text()).toBe("undefined");
  });
});

describe("render() inside workerd", () => {
  it.each(FIXTURES)("renders %s exactly as Node does", async (name) => {
    const doc = loadFixture(name);
    const response = await server.fetch("https://probe.localhost/", { method: "POST", body: JSON.stringify(doc) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(render(doc, { stylesheet: SITE_CSS, formAction: PROBE_FORM_ACTION }));
  });

  it("rejects an invalid document inside the Worker too", async () => {
    const doc = loadFixture("cleaning-minimal");
    const response = await server.fetch("https://probe.localhost/", {
      method: "POST",
      body: JSON.stringify({ ...doc, copy: { ...doc.copy, heroHeadline: "Call 512-555-0142" } }),
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toBe("ZodError");
  });
});
