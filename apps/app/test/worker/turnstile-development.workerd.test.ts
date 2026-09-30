import { describe, expect, it } from "vitest";
import { nextIp, useAppHarness } from "../support/harness.ts";
import { TURNSTILE_DUMMY_TOKEN } from "../support/turnstile.ts";

// The dummy-secret gate (binding ruling, 2026-09-30): ENVIRONMENT "development" AND the CONFIGURED APP_ORIGIN
// host is local (localhost, *.localhost, 127.0.0.1, [::1]). The request's Host header is never used.
const REMOTE_ORIGIN = "https://app.example.test";
const remote = useAppHarness({ vars: { ENVIRONMENT: "development", APP_ORIGIN: REMOTE_ORIGIN } });
const localhost = useAppHarness({ vars: { ENVIRONMENT: "development", APP_ORIGIN: "https://localhost:8787" } });
const loopback4 = useAppHarness({ vars: { ENVIRONMENT: "development", APP_ORIGIN: "https://127.0.0.1:8787" } });
const loopback6 = useAppHarness({ vars: { ENVIRONMENT: "development", APP_ORIGIN: "https://[::1]:8787" } });
const evilSuffix = useAppHarness({ vars: { ENVIRONMENT: "development", APP_ORIGIN: "https://evillocalhost" } });
const evilInfix = useAppHarness({ vars: { ENVIRONMENT: "development", APP_ORIGIN: "https://app.localhost.evil.com" } });

function login(harness: typeof remote, origin: string, requestBase: string): Promise<Response> {
  return harness.server.fetch(`${requestBase}/api/auth/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": nextIp(), "x-turnstile-token": TURNSTILE_DUMMY_TOKEN },
    body: JSON.stringify({ email: "owner@example.com" }),
  });
}

describe("Turnstile dummy secret in development", () => {
  it("is refused when the configured host is not local, even with a forged *.localhost request Host", async () => {
    remote.server.clearLogs();
    const res = await login(remote, REMOTE_ORIGIN, "https://x.localhost");
    expect(res.status).toBe(403);
    const lines = remote.logLines().filter((line) => line["route"] === "POST /api/auth/login").map((line) => line["turnstile"]);
    expect(lines).toEqual(["testing_key"]);
  });

  it.each([
    ["localhost", localhost, "https://localhost:8787"],
    ["127.0.0.1", loopback4, "https://127.0.0.1:8787"],
    ["[::1]", loopback6, "https://[::1]:8787"],
  ])("passes when the configured host is %s", async (_name, harness, origin) => {
    const res = await login(harness, origin, origin);
    expect(res.status).toBe(202);
  });

  it.each([
    ["evillocalhost", evilSuffix, "https://evillocalhost"],
    ["app.localhost.evil.com", evilInfix, "https://app.localhost.evil.com"],
  ])("is refused when the configured host only contains localhost: %s", async (_name, harness, origin) => {
    harness.server.clearLogs();
    const res = await login(harness, origin, origin);
    expect(res.status).toBe(403);
    const lines = harness.logLines().filter((line) => line["route"] === "POST /api/auth/login").map((line) => line["turnstile"]);
    expect(lines).toEqual(["testing_key"]);
  });
});
