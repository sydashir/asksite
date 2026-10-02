import { describe, expect, it } from "vitest";
import { useAdminHarness } from "../support/harness.ts";

// Approve and reject build the owner email's mailer and check APP_ORIGIN before anything changes, so a
// configuration error is a plain 500 internal that leaves the version pending (moderator ruling, 2026-09-30).
// Each value runs its own Worker, with its own fresh D1, because the value is part of the Worker's configuration.

type Harness = ReturnType<typeof useAdminHarness>;

async function refusedAsInternal(h: Harness, action: "approve" | "reject"): Promise<void> {
  const site = await h.pendingSite();
  const body = action === "approve" ? { htmlSha256: site.htmlSha256 } : { note: "Please use your own photos." };
  const res = await h.call("POST", `/api/admin/versions/${site.versionId}/${action}`, { body });
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: { code: "internal", message: "Something went wrong. Please try again." } });
  const db = await h.db();
  expect(await db.prepare("SELECT status, reviewed_at FROM site_versions WHERE id = ?").bind(site.versionId).first()).toEqual({ status: "pending", reviewed_at: null });
  expect(await db.prepare("SELECT live_version_id, pending_version_id FROM sites WHERE id = ?").bind(site.siteId).first()).toEqual({
    live_version_id: null,
    pending_version_id: site.versionId,
  });
  expect((await db.prepare("SELECT action FROM audit_log WHERE site_id = ? ORDER BY id").bind(site.siteId).all()).results).toEqual([{ action: "version.requested" }]);
  expect(await h.liveKeys(site.slug)).toEqual([]);
}

describe("approve and reject when MAILER is neither resend nor log", () => {
  const h = useAdminHarness({ MAILER: "resnd" });

  it("approve answers 500 internal and leaves the version pending", async () => {
    await refusedAsInternal(h, "approve");
  });

  it("reject answers 500 internal and leaves the version pending", async () => {
    await refusedAsInternal(h, "reject");
  });
});

describe("approve and reject when APP_ORIGIN is not a bare https origin", () => {
  const h = useAdminHarness({ APP_ORIGIN: "https://app.localhost:8787/" });

  it("approve answers 500 internal and leaves the version pending", async () => {
    await refusedAsInternal(h, "approve");
  });

  it("reject answers 500 internal and leaves the version pending", async () => {
    await refusedAsInternal(h, "reject");
  });
});
