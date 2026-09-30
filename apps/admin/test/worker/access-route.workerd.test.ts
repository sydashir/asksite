import { describe, expect, it } from "vitest";
import { accessToken, json, useAdminHarness } from "../support/harness.ts";

const h = useAdminHarness();

type ErrorJson = { error: { code: string; message: string } };

/** The answer of the Fetch Metadata gate, and of requireOrigin. */
const ANOTHER_SITE = { error: { code: "forbidden", message: "This request is not allowed from another site" } };
/** The answer of the Access check. */
const NOT_ALLOWED = { error: { code: "forbidden", message: "You are not allowed to use the admin" } };

/** The owner app's origin (APP_ORIGIN in test/wrangler.test.jsonc): the same site as the admin, another origin. */
const APP_ORIGIN = "https://app.localhost:8787";

describe("access", () => {
  it("refuses a request without a valid Access token, for an email not on the list, and from another origin", async () => {
    expect((await h.call("GET", "/api/admin/me", { token: null })).status).toBe(403);
    expect((await h.call("GET", "/api/admin/me", { token: await accessToken({ email: "intruder@example.com" }) })).status).toBe(403);
    const me = await h.call("GET", "/api/admin/me");
    expect(await me.json()).toEqual({ email: "admin@example.com" });
    expect(me.headers.get("X-Frame-Options")).toBe("DENY");
    const csrf = await h.call("POST", "/api/admin/invites", { body: { email: "a@example.com" }, origin: "https://evil.example" });
    expect(csrf.status).toBe(403);
  });
});

// Moderator ruling (2026-09-29): on /api/admin/* the Fetch Metadata gate runs first, then requireOrigin, then
// Access and the allowlist, then ADMIN_RL. Each answer is checked by status AND message, which shows which step
// refused it. That a refused request never reaches ADMIN_RL is shown in rate-limit.workerd.test.ts.
describe("Fetch Metadata gate", () => {
  it("refuses a cross-site GET with a valid Access token: 403, still with the API headers", async () => {
    const res = await h.call("GET", "/api/admin/me", { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(res.status).toBe(403);
    expect(await json<ErrorJson>(res)).toEqual(ANOTHER_SITE);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it.each(["same-site", "none"])("refuses a %s request the same way: only the admin's own pages call this API", async (site) => {
    const res = await h.call("GET", "/api/admin/me", { headers: { "Sec-Fetch-Site": site } });
    expect(res.status).toBe(403);
    expect(await json<ErrorJson>(res)).toEqual(ANOTHER_SITE);
  });

  it.each(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("refuses a cross-site %s, even with a valid token and our Origin", async (method) => {
    const res = await h.call(method, "/api/admin/me", { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(res.status).toBe(403);
    // An answer to HEAD has no body.
    if (method !== "HEAD") expect(await json<ErrorJson>(res)).toEqual(ANOTHER_SITE);
  });

  it.each(["GET", "POST"])("refuses a cross-site %s before the Access check: without a token it still gets the other-site answer", async (method) => {
    const res = await h.call(method, "/api/admin/invites", { token: null, origin: "https://evil.example", headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(res.status).toBe(403);
    expect(await json<ErrorJson>(res)).toEqual(ANOTHER_SITE);
  });

  it("lets a same-origin request through (the admin's own pages)", async () => {
    const res = await h.call("GET", "/api/admin/me", { headers: { "Sec-Fetch-Site": "same-origin" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "admin@example.com" });
  });

  it("lets the review frame load: a browser's same-origin iframe navigation, which carries no Origin", async () => {
    const res = await h.call("GET", "/api/admin/me", { origin: null, headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "admin@example.com" });
  });

  describe("without Fetch Metadata (a client that does not send it)", () => {
    it.each([
      ["another site's", "https://evil.example"],
      ["the owner app's", APP_ORIGIN],
      ["no", null],
    ])("refuses a change with %s Origin before the Access check: requireOrigin still applies", async (_name, origin) => {
      const res = await h.call("POST", "/api/admin/invites", { token: null, origin, body: { email: "a@example.com" } });
      expect(res.status).toBe(403);
      expect(await json<ErrorJson>(res)).toEqual(ANOTHER_SITE);
    });

    it("refuses such a change from a signed-in admin too", async () => {
      const res = await h.call("POST", "/api/admin/invites", { origin: APP_ORIGIN, body: { email: "a@example.com" } });
      expect(res.status).toBe(403);
      expect(await json<ErrorJson>(res)).toEqual(ANOTHER_SITE);
    });

    it("answers a GET without a valid token with the Access refusal", async () => {
      const res = await h.call("GET", "/api/admin/me", { token: null });
      expect(res.status).toBe(403);
      expect(await json<ErrorJson>(res)).toEqual(NOT_ALLOWED);
    });
  });
});
