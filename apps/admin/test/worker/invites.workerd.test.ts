import { sha256Hex, type InviteView } from "@asksite/core";
import { describe, expect, it } from "vitest";
import { useAdminHarness } from "../support/harness.ts";

const h = useAdminHarness();

/** Every key of an InviteView, and nothing else: no token and no token hash can ride along in an answer. */
const INVITE_VIEW_KEYS = ["createdAt", "createdBy", "email", "expiresAt", "id", "revokedAt", "siteId", "usedAt"];

describe("invites", () => {
  it("emails the invite link, never returns it, stores only its hash, and lists and revokes invites with audit rows", async () => {
    const res = await h.call("POST", "/api/admin/invites", { body: { email: "New.Owner@Example.com" } });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toMatch(/invite#/);
    const { invite } = JSON.parse(text) as { invite: InviteView };
    expect(invite).toMatchObject({ email: "new.owner@example.com", createdBy: "admin@example.com", usedAt: null, revokedAt: null, siteId: null });
    expect(Object.keys(invite).sort()).toEqual(INVITE_VIEW_KEYS);
    const [email] = await h.outbox("new.owner@example.com");
    expect(email).toMatchObject({ subject: "You're invited to set up your business website", tag: "invite" });
    const token = /https:\/\/app\.localhost:8787\/invite#([A-Za-z0-9_-]{43})/.exec(email?.text ?? "")?.[1] ?? "";
    expect(token).toHaveLength(43);
    expect(text).not.toContain(token);
    const db = await h.db();
    const stored = await db.prepare("SELECT token_hash FROM invites WHERE id = ?").bind(invite.id).first<{ token_hash: string }>();
    expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.token_hash).toBe(await sha256Hex(token));
    expect(text).not.toContain(stored?.token_hash);

    const listText = await (await h.call("GET", "/api/admin/invites")).text();
    expect(listText).not.toContain(token);
    expect(listText).not.toContain(stored?.token_hash);
    const list = JSON.parse(listText) as { invites: InviteView[] };
    expect(list.invites.map((i) => i.id)).toContain(invite.id);
    for (const item of list.invites) expect(Object.keys(item).sort()).toEqual(INVITE_VIEW_KEYS);
    expect((await h.call("DELETE", `/api/admin/invites/${invite.id}`)).status).toBe(204);
    const row = await db.prepare("SELECT revoked_at FROM invites WHERE id = ?").bind(invite.id).first<{ revoked_at: number | null }>();
    expect(row?.revoked_at).not.toBeNull();
    expect((await h.call("DELETE", "/api/admin/invites/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    const audit = await db
      .prepare("SELECT action, actor FROM audit_log WHERE action IN ('invite.created', 'invite.revoked') AND detail_json = ? ORDER BY id")
      .bind(JSON.stringify({ inviteId: invite.id }))
      .all<{ action: string; actor: string }>();
    expect(audit.results).toEqual([
      { action: "invite.created", actor: "admin:admin@example.com" },
      { action: "invite.revoked", actor: "admin:admin@example.com" },
    ]);
  });

  it("keeps no invite when the email cannot be sent (502 email_failed), and logs the mailer's code but never the address", async () => {
    h.server.clearLogs();
    const res = await h.call("POST", "/api/admin/invites", { body: { email: "someone@mail-fails.example" } });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: "email_failed", message: "Email could not be sent, try again" } });
    const rows = await (await h.db()).prepare("SELECT id FROM invites WHERE email = ?").bind("someone@mail-fails.example").all();
    expect(rows.results).toEqual([]);
    // The fake mailer refuses this address as Plan 2's MailerError "rejected" (apps/app/test/support/fakes.ts).
    expect(h.logLines()).toEqual([{ route: "POST /api/admin/invites", status: 502, ms: expect.any(Number), error: "rejected", code: "email_failed" }]);
    expect(h.server.getLogs().map((entry) => entry.message).join("\n")).not.toContain("mail-fails");
  });
});
