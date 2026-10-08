import { describe, expect, it } from "vitest";
import { useAdminHarness } from "../support/harness.ts";

// The sign-in link's mailer and email are built before its token exists, so a configuration error is a plain 500
// internal that leaves no token, no email and no audit row (moderator ruling, 2026-09-30, as the invites). Each value
// runs its own Worker, with its own fresh D1, because the value is part of the Worker's configuration.

type Harness = ReturnType<typeof useAdminHarness>;

async function refusedAsInternal(h: Harness): Promise<void> {
  const site = await h.pendingSite();
  h.server.clearLogs();
  const res = await h.call("POST", `/api/admin/owners/${site.ownerId}/sign-in-link`, { body: {} });
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: { code: "internal", message: "Something went wrong. Please try again." } });
  const db = await h.db();
  expect((await db.prepare("SELECT COUNT(*) AS n FROM login_tokens WHERE owner_id = ?").bind(site.ownerId).first<{ n: number }>())?.n).toBe(0);
  expect((await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.login_link_sent'").bind().first<{ n: number }>())?.n).toBe(0);
  expect(h.logLines()).toEqual([{ route: "POST /api/admin/owners/:ownerId/sign-in-link", status: 500, ms: expect.any(Number), code: "internal", error: "Error" }]);
}

describe("a sign-in link when MAILER is neither resend nor log", () => {
  const h = useAdminHarness({ MAILER: "resnd" });
  it("answers 500 internal and keeps no token", async () => {
    await refusedAsInternal(h);
  });
});

describe("a sign-in link when APP_ORIGIN is not a bare https origin", () => {
  const h = useAdminHarness({ APP_ORIGIN: "https://app.localhost:8787/" });
  it("answers 500 internal and keeps no token", async () => {
    await refusedAsInternal(h);
  });
});

describe("the stats when LOGIN_EMAILS_PER_DAY is 2", () => {
  const h = useAdminHarness({ LOGIN_EMAILS_PER_DAY: "2" });
  it("shows that cap, and the time the 2nd link of the day was made", async () => {
    const site = await h.pendingSite();
    const db = await h.db();
    const at = Date.UTC(2031, 0, 15, 0, 5, 0);
    for (const [i, createdAt] of [at, at + 60_000, at + 120_000].entries()) {
      await db.prepare("INSERT INTO login_tokens (token_hash, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(`t${i}`, site.ownerId, createdAt, createdAt + 1000).run();
    }
    const res = await h.call("GET", "/api/admin/sign-in-emails", { headers: { "X-Test-Now": String(Date.UTC(2031, 0, 15, 9, 0, 0)) } });
    expect(await res.json()).toEqual({ sentToday: 3, dailyCap: 2, capReachedAt: at + 60_000 });
  });
});
