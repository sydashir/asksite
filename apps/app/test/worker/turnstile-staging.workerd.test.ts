import { describe, expect, it } from "vitest";
import { APP_ORIGIN, nextIp, useAppHarness } from "../support/harness.ts";
import { TURNSTILE_DUMMY_TOKEN } from "../support/turnstile.ts";

// D1 (moderator): Cloudflare's test-key result stands in for the host name check only in development.
// Every other environment refuses it, not just "production": here the Worker runs as "staging" on the
// very *.localhost host where development would accept it.
const h = useAppHarness({ vars: { ENVIRONMENT: "staging" } });

describe("Turnstile outside development and production", () => {
  it("refuses the test-key result in staging, even on a *.localhost host", async () => {
    h.server.clearLogs();
    const res = await h.call("POST", "/api/auth/login", { body: { email: "owner@example.com" }, ip: nextIp(), headers: { "x-turnstile-token": TURNSTILE_DUMMY_TOKEN } });
    expect(new URL(APP_ORIGIN).hostname.endsWith(".localhost")).toBe(true);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "forbidden", message: "Please complete the security check and try again." } });
    const reasons = h.logLines().filter((line) => line["route"] === "POST /api/auth/login").map((line) => line["turnstile"]);
    expect(reasons).toEqual(["testing_key"]);
  });
});
