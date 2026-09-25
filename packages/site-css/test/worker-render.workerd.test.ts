import { resolve } from "node:path";
import { render } from "@asksite/renderer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { FIXTURES, loadFixture } from "../../../fixtures/index.ts";
import { SITE_CSS } from "../src/index.ts";
import { PROBE_FORM_ACTION } from "./support/probe-form-action.ts";

// Proves the Worker bundle: wrangler (esbuild) bundles @asksite/renderer, zod and the generated
// stylesheet, and workerd renders every fixture byte-for-byte like Node does.
const server = createTestHarness({
  root: resolve(import.meta.dirname, "../../.."),
  workers: [{ config: { name: "render-probe", main: "packages/site-css/test/support/render-probe.ts", compatibility_date: "2026-09-21" } }],
});

beforeAll(async () => {
  await server.listen();
}, 120_000);
afterAll(async () => {
  await server.close();
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
