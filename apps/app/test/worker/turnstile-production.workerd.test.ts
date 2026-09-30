import { describe, expect, it } from "vitest";
import { nextIp, useAppHarness } from "../support/harness.ts";
import { liveToken, TURNSTILE_DUMMY_TOKEN, TURNSTILE_LIVE_SECRET, TURNSTILE_TEST_HOSTNAME } from "../support/turnstile.ts";

// D1 (moderator, 2026-09-26): outside development, Cloudflare's test-key result is refused even with
// success true, and a production key's result must name this app's host. The Worker runs as production
// here, with its origin on the very host name the test-key result names, so only the test-key rule can
// refuse that result. (The /__test/* helpers answer 404 in production, so this file needs none of them.)
const ORIGIN = `https://${TURNSTILE_TEST_HOSTNAME}`;
const h = useAppHarness({ vars: { ENVIRONMENT: "production", APP_ORIGIN: ORIGIN } });
// The same Worker with a production-style secret (not a documented dummy one).
const live = useAppHarness({ vars: { ENVIRONMENT: "production", APP_ORIGIN: ORIGIN, TURNSTILE_SECRET_KEY: TURNSTILE_LIVE_SECRET } });

const REFUSED = { error: { code: "forbidden", message: "Please complete the security check and try again." } };

/** POST /api/auth/login to `base` (the host name the Worker sees), from this app's origin. */
function login(base: string, token: string, harness = h): Promise<Response> {
  return harness.server.fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": nextIp(), "x-turnstile-token": token },
    body: JSON.stringify({ email: "owner@example.com" }),
  });
}

/** The Turnstile reason on each login request's log line so far. */
const reasons = (): unknown[] => h.logLines().filter((line) => line["route"] === "POST /api/auth/login").map((line) => line["turnstile"]);

describe("Turnstile in production (D1)", () => {
  it("refuses the test-key result even with success true and this very host name", async () => {
    h.server.clearLogs();
    const res = await login(ORIGIN, TURNSTILE_DUMMY_TOKEN);
    expect(res.headers.get("Strict-Transport-Security")).not.toBeNull(); // the Worker really runs as production
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(REFUSED);
    expect(reasons()).toEqual(["testing_key"]);
  });

  it("refuses the test-key result on a *.localhost host too: the allowance is for development only", async () => {
    h.server.clearLogs();
    const res = await login("https://app.localhost:8787", TURNSTILE_DUMMY_TOKEN);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(REFUSED);
    expect(reasons()).toEqual(["testing_key"]);
  });

  it("accepts a production key's result only when it names this app's host and the login action", async () => {
    live.server.clearLogs();
    expect((await login(ORIGIN, liveToken(TURNSTILE_TEST_HOSTNAME), live)).status).toBe(202);
    const elsewhere = await login(ORIGIN, liveToken("app.localhost"), live);
    expect(elsewhere.status).toBe(403);
    expect(await elsewhere.json()).toEqual(REFUSED);
    const wrongAction = await login(ORIGIN, liveToken(TURNSTILE_TEST_HOSTNAME, "contact"), live);
    expect(wrongAction.status).toBe(403);
    const lines = live.logLines().filter((line) => line["route"] === "POST /api/auth/login").map((line) => line["turnstile"]);
    expect(lines).toEqual([undefined, "hostname", "action"]);
  });
});
