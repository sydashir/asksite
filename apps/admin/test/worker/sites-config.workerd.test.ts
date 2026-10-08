import { describe, expect, it } from "vitest";
import { useAdminHarness } from "../support/harness.ts";

// The takedown notice's mailer and email are built before the takedown, so a configuration error is a plain 500
// internal that leaves the site up (moderator ruling, 2026-09-30). Each value runs its own Worker.

type Harness = ReturnType<typeof useAdminHarness>;

async function refusedAsInternal(h: Harness): Promise<void> {
  const site = await h.pendingSite();
  const res = await h.call("POST", `/api/admin/sites/${site.siteId}/takedown`, { body: { reason: "Spam report" } });
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: { code: "internal", message: "Something went wrong. Please try again." } });
  const row = await (await h.db()).prepare("SELECT taken_down_at FROM sites WHERE id = ?").bind(site.siteId).first<{ taken_down_at: number | null }>();
  expect(row?.taken_down_at).toBeNull();
  const audit = await (await h.db()).prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'site.taken_down' AND site_id = ?").bind(site.siteId).first<{ n: number }>();
  expect(audit?.n).toBe(0);
}

describe("a takedown when MAILER is neither resend nor log", () => {
  const h = useAdminHarness({ MAILER: "resnd" });
  it("answers 500 internal and leaves the site as it was", async () => {
    await refusedAsInternal(h);
  });
});

describe("a takedown when APP_ORIGIN is not a bare https origin", () => {
  const h = useAdminHarness({ APP_ORIGIN: "https://app.localhost:8787/" });
  it("answers 500 internal and leaves the site as it was", async () => {
    await refusedAsInternal(h);
  });
});

describe("a takedown when SUPPORT_EMAIL is not an address", () => {
  const h = useAdminHarness({ SUPPORT_EMAIL: "not an address" });
  it("answers 500 internal and leaves the site as it was", async () => {
    await refusedAsInternal(h);
  });
});
