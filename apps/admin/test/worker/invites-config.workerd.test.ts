import { describe, expect, it } from "vitest";
import { useAdminHarness } from "../support/harness.ts";

// The invite's mailer and email are built before its row exists, so a configuration error is a plain
// 500 internal that leaves no invite, never "Email could not be sent, try again" (moderator ruling on
// review I1, 2026-09-30). Each value runs its own Worker, with its own fresh D1, because the value is
// part of the Worker's configuration.

type Harness = ReturnType<typeof useAdminHarness>;

async function refusedAsInternal(h: Harness, email: string): Promise<void> {
  h.server.clearLogs();
  const res = await h.call("POST", "/api/admin/invites", { body: { email } });
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: { code: "internal", message: "Something went wrong. Please try again." } });
  const rows = await (await h.db()).prepare("SELECT id FROM invites WHERE email = ?").bind(email).all();
  expect(rows.results).toEqual([]);
  expect(h.logLines()).toEqual([{ route: "POST /api/admin/invites", status: 500, ms: expect.any(Number), code: "internal", error: "Error" }]);
}

describe("an invite when MAILER is neither resend nor log", () => {
  const h = useAdminHarness({ MAILER: "resnd" });

  it("answers 500 internal and keeps no invite", async () => {
    await refusedAsInternal(h, "mailer.typo@example.com");
  });
});

describe("an invite when APP_ORIGIN is not a bare https origin", () => {
  const h = useAdminHarness({ APP_ORIGIN: "https://app.localhost:8787/" });

  it("answers 500 internal and keeps no invite", async () => {
    await refusedAsInternal(h, "origin.typo@example.com");
  });
});
