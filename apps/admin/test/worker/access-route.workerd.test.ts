import { describe, expect, it } from "vitest";
import { accessToken, useAdminHarness } from "../support/harness.ts";

const h = useAdminHarness();

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
