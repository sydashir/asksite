import { resolve } from "node:path";
import { render } from "@asksite/renderer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { DESIGN_IDS } from "@asksite/site-schema";
import { FIXTURES, inDesign, loadFixture } from "../../../fixtures/index.ts";
import { DESIGN_CSS } from "../src/index.ts";
import { PROBE_FORM_ACTION } from "./support/probe-form-action.ts";

// Proves the Worker bundle: wrangler (esbuild) bundles @asksite/renderer, zod and the generated
// stylesheets, and workerd renders every fixture in every design byte-for-byte like Node does, with
// that design's own sheet (A12).
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

const post = (doc: unknown) => server.fetch("https://probe.localhost/", { method: "POST", body: JSON.stringify(doc) });

describe("render() inside workerd", () => {
  describe.each(DESIGN_IDS)("in the %s design", (design) => {
    it.each(FIXTURES)("renders %s exactly as Node does, with the design's own sheet", async (name) => {
      const doc = inDesign(loadFixture(name), design);
      const response = await post(doc);
      expect(response.status).toBe(200);
      const page = render(doc, { stylesheets: DESIGN_CSS, formAction: PROBE_FORM_ACTION });
      expect(await response.text()).toBe(page.html);
      expect([response.headers.get("x-design"), response.headers.get("x-stylesheet-sha256")]).toEqual([design, DESIGN_CSS[design].sha256]);
    });
  });

  it("renders a stored document without a design in the default design", async () => {
    const doc = loadFixture("electrical-xss");
    expect(doc.theme).not.toHaveProperty("design");
    const response = await post(doc);
    expect(response.headers.get("x-design")).toBe("impact");
    expect(await response.text()).toContain('<body data-design="impact"');
  });

  it("rejects an invalid document inside the Worker too", async () => {
    const doc = loadFixture("cleaning-minimal");
    const response = await post({ ...doc, copy: { ...doc.copy, heroHeadline: "Call 512-555-0142" } });
    expect(response.status).toBe(422);
    expect(await response.text()).toBe("ZodError");
  });
});
