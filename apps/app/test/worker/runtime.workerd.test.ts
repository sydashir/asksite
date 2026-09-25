import { describe, expect, it } from "vitest";
import { json, useAppHarness } from "../support/harness.ts";

// A13: with Node.js compatibility off (no_nodejs_compat and no_nodejs_compat_v2), the Worker has no
// `process`, so no library can read its variables and secrets from process.env.
const h = useAppHarness();

describe("runtime (A13)", () => {
  it("has no Node.js process global inside the app Worker", async () => {
    const res = await h.call("GET", "/__test/runtime");
    expect(res.status).toBe(200);
    expect(await json<{ process: string }>(res)).toEqual({ process: "undefined" });
  });
});
