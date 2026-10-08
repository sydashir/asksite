import { expect, test } from "@playwright/test";
import { APP } from "./support.ts";

// A13 for the Vite-built Worker (bundled by Rolldown, not wrangler's esbuild): with Node.js compatibility
// off there is no `process` inside it, and node:process, if importable, has nothing to read. Mirrors
// test/worker/runtime.workerd.test.ts, which proves the same for the wrangler-built test Worker.
interface RuntimeProbe {
  process: string;
  nodeProcess: { importable: true; envKeys: string[]; readable: string[]; checked: string[] } | { importable: false; error: string };
}

test("the built Worker has no Node.js process and node:process holds no variables (A13)", async ({ request }) => {
  const res = await request.get(`${APP}/__test/runtime`);
  expect(res.status()).toBe(200);
  const probe = (await res.json()) as RuntimeProbe;
  expect(probe.process).toBe("undefined");
  if (probe.nodeProcess.importable) {
    expect(probe.nodeProcess.checked).toEqual(expect.arrayContaining(["RESEND_API_KEY", "IP_HASH_KEY", "TURNSTILE_SECRET_KEY", "APP_ORIGIN", "DB"]));
    expect({ envKeys: probe.nodeProcess.envKeys, readable: probe.nodeProcess.readable }).toEqual({ envKeys: [], readable: [] });
  } else {
    expect(probe.nodeProcess.error).not.toBe("");
  }
});
