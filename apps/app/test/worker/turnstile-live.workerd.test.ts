import { describe, expect, it } from "vitest";
import { APP_ORIGIN, useAppHarness } from "../support/harness.ts";
import { LIVE_TOKEN_NO_HOSTNAME, liveToken, TURNSTILE_DUMMY_TOKEN, TURNSTILE_LIVE_SECRET, TURNSTILE_NEAR_MISS_SECRET, TURNSTILE_TEST_ACTION, TURNSTILE_TEST_HOSTNAME } from "../support/turnstile.ts";

// Docs (developers.cloudflare.com/turnstile/get-started/server-side-validation/): "Check if action matches
// expected value" and "Check if hostname matches expected value". The Worker here holds a production-style
// secret (not a documented dummy one), so the app's own action ("login") and host name are enforced.
const h = useAppHarness({ vars: { TURNSTILE_SECRET_KEY: TURNSTILE_LIVE_SECRET } });
const HOST = new URL(APP_ORIGIN).hostname;
const REFUSED = { error: { code: "forbidden", message: "Please complete the security check and try again." } };

const reasons = (): unknown[] => h.logLines().filter((line) => line["route"] === "POST /api/auth/login").map((line) => line["turnstile"]);

async function refused(token: string): Promise<Response> {
  const res = await h.login("owner@example.com", { turnstile: token });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual(REFUSED);
  return res;
}

describe("Turnstile with a production-style secret key", () => {
  it("accepts a result for this host name and the login action", async () => {
    expect((await h.login("owner@example.com", { turnstile: liveToken(HOST) })).status).toBe(202);
  });

  it("refuses a result for another action, and says why only on the log line", async () => {
    h.server.clearLogs();
    await refused(liveToken(HOST, "contact"));
    expect(reasons()).toEqual(["action"]);
  });

  it("refuses a result for another host name, and says why only on the log line", async () => {
    h.server.clearLogs();
    await refused(liveToken("evil.example"));
    expect(reasons()).toEqual(["hostname"]);
  });

  it("refuses a result that names no host name", async () => {
    h.server.clearLogs();
    await refused(LIVE_TOKEN_NO_HOSTNAME);
    expect(reasons()).toEqual(["hostname"]);
  });

  it("refuses the dummy token, which only the documented test secrets accept", async () => {
    h.server.clearLogs();
    await refused(TURNSTILE_DUMMY_TOKEN);
    expect(reasons()).toEqual(["rejected"]);
  });

  it("does not give action test and host localhost a pass: that answer is only for the documented dummy secrets", async () => {
    h.server.clearLogs();
    await refused(liveToken(TURNSTILE_TEST_HOSTNAME, TURNSTILE_TEST_ACTION));
    expect(reasons()).toEqual(["action"]);
  });
});

describe("a secret one character off a dummy secret", () => {
  const near = useAppHarness({ vars: { TURNSTILE_SECRET_KEY: TURNSTILE_NEAR_MISS_SECRET } });

  it("gets no dummy allowance: an answer of action test and host localhost is refused", async () => {
    near.server.clearLogs();
    const res = await near.login("owner@example.com", { turnstile: liveToken(TURNSTILE_TEST_HOSTNAME, TURNSTILE_TEST_ACTION) });
    expect(res.status).toBe(403);
    expect(near.logLines().filter((line) => line["route"] === "POST /api/auth/login").map((line) => line["turnstile"])).toEqual(["action"]);
  });
});

