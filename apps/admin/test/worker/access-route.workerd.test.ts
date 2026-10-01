import type { InviteView } from "@asksite/core";
import { beforeAll, describe, expect, it } from "vitest";
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

// F8: every admin route refuses a request with no token, and one with a token for an email not on the list, with
// 403 and no side effect. A route mounted outside the gate would show here, whatever its own tests say.
describe("every admin route is behind the gate", () => {
  let routes: Array<[string, string, unknown]> = [];

  beforeAll(async () => {
    const site = await h.pendingSite();
    const invite = (await json<{ invite: InviteView }>(await h.call("POST", "/api/admin/invites", { body: { email: "invitee@example.com" } }))).invite;
    const unknown = "00000000-0000-4000-8000-000000000000";
    routes = [
      ["GET", "/api/admin/me", undefined],
      ["GET", "/api/admin/invites", undefined],
      ["POST", "/api/admin/invites", { email: "x@example.com" }],
      ["DELETE", `/api/admin/invites/${invite.id}`, undefined],
      ["GET", "/api/admin/reviews", undefined],
      ["GET", `/api/admin/versions/${site.versionId}`, undefined],
      ["GET", `/api/admin/versions/${site.versionId}/page`, undefined],
      ["POST", `/api/admin/versions/${site.versionId}/approve`, { htmlSha256: site.htmlSha256 }],
      ["POST", `/api/admin/versions/${site.versionId}/reject`, { note: "No" }],
      ["GET", "/api/admin/sites", undefined],
      ["GET", `/api/admin/sites/${site.siteId}`, undefined],
      ["POST", `/api/admin/sites/${site.siteId}/takedown`, { reason: "Spam report" }],
      ["POST", `/api/admin/sites/${site.siteId}/restore`, {}],
      ["PUT", `/api/admin/sites/${site.siteId}/indexable`, { indexable: false }],
      ["POST", `/api/admin/owners/${site.ownerId}/disable`, { reason: "Abuse" }],
      ["POST", `/api/admin/owners/${site.ownerId}/enable`, {}],
      ["POST", `/api/admin/owners/${site.ownerId}/sign-in-link`, {}],
      ["GET", "/api/admin/sign-in-emails", undefined],
      ["GET", "/api/admin/settings", undefined],
      ["PUT", "/api/admin/settings", { generationEnabled: false, dailyModelLimit: 1 }],
      ["POST", `/api/admin/owners/${unknown}/disable`, { reason: "x" }],
    ];
  }, 120_000);

  /** Every table an admin route reads or writes, whole. A refused request must leave all of it as it was. */
  async function snapshot(): Promise<string> {
    const db = await h.db();
    const tables = ["audit_log", "invites", "owners", "sites", "site_versions", "settings", "sessions", "login_tokens", "dev_outbox"];
    const rows = await Promise.all(tables.map(async (table) => (await db.prepare(`SELECT * FROM ${table}`).bind().all()).results));
    return JSON.stringify(rows);
  }

  it.each([
    ["no token", async () => null],
    ["a token for an email not on the list", () => accessToken({ email: "intruder@example.com" })],
  ])("refuses %s with 403 and changes nothing", async (_name, makeToken) => {
    expect(routes.length).toBeGreaterThan(20);
    const token = await makeToken();
    const before = await snapshot();
    for (const [method, path, body] of routes) {
      const res = await h.call(method, path, { token, ...(body === undefined ? {} : { body }) });
      const text = await res.text();
      expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 403`);
      expect(JSON.parse(text)).toEqual(NOT_ALLOWED);
      expect(text).not.toContain("invitee@example.com");
    }
    expect(await snapshot()).toBe(before);
  });
});

// F7: the gate's log line says why it refused, in a fixed token: never the token, an email or a key.
describe("the log line of a refused request", () => {
  async function refusalLine(options: Parameters<typeof h.call>[2]): Promise<Record<string, unknown>> {
    h.server.clearLogs();
    expect((await h.call("GET", "/api/admin/me", options)).status).toBe(403);
    const lines = h.logLines();
    expect(lines).toHaveLength(1);
    return lines[0]!;
  }

  it("names no_token, invalid_token, not_on_list and fetch_metadata_refused", async () => {
    const base = { route: "GET /api/admin/*", status: 403, ms: expect.any(Number), code: "forbidden" };
    expect(await refusalLine({ token: null })).toEqual({ ...base, reason: "no_token" });
    expect(await refusalLine({ token: "forged.token.value" })).toEqual({ ...base, reason: "invalid_token" });
    expect(await refusalLine({ token: await accessToken({ noExpiry: true }) })).toEqual({ ...base, reason: "invalid_token" });
    expect(await refusalLine({ token: await accessToken({ email: "intruder@example.com" }) })).toEqual({ ...base, reason: "not_on_list" });
    expect(await refusalLine({ headers: { "Sec-Fetch-Site": "cross-site" } })).toEqual({ ...base, reason: "fetch_metadata_refused" });
  });

  it("never logs the token, an email or the team domain", async () => {
    const token = await accessToken({ email: "intruder@example.com" });
    h.server.clearLogs();
    await h.call("GET", "/api/admin/me", { token });
    const raw = h.server.getLogs().map((entry) => entry.message).join("\n");
    expect(raw).not.toContain(token);
    expect(raw).not.toMatch(/intruder|@|cloudflareaccess|test-aud/);
  });
});
