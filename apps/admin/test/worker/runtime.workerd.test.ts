import { describe, expect, it } from "vitest";
import { json, useAdminHarness } from "../support/harness.ts";

// A13: with Node.js compatibility off (no_nodejs_compat and no_nodejs_compat_v2), the Worker has no
// `process`, so no library can read its variables and secrets from process.env.
const h = useAdminHarness();

interface RuntimeProbe {
  process: string;
  nodeProcess: { importable: true; envKeys: string[]; readable: string[]; checked: string[] } | { importable: false; error: string };
}

describe("runtime (A13)", () => {
  it("has no Node.js process global inside the admin Worker", async () => {
    const res = await h.call("GET", "/__test/runtime", { token: null });
    expect(res.status).toBe(200);
    expect((await json<RuntimeProbe>(res)).process).toBe("undefined");
  });

  it("gives node:process nothing to read: it is either not importable, or its env is empty", async () => {
    const { nodeProcess } = await json<RuntimeProbe>(await h.call("GET", "/__test/runtime", { token: null }));
    if (nodeProcess.importable) {
      // Every binding name of the Worker was tried on it, the secret included (names only, never values).
      expect(nodeProcess.checked).toEqual(expect.arrayContaining(["RESEND_API_KEY", "ADMIN_EMAILS", "ADMIN_ORIGIN", "DB"]));
      expect({ envKeys: nodeProcess.envKeys, readable: nodeProcess.readable }).toEqual({ envKeys: [], readable: [] });
    } else {
      expect(nodeProcess.error).not.toBe("");
    }
  });
});
