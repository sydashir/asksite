import { newId, sha256Hex, type InviteView } from "@asksite/core";
import { describe, expect, it } from "vitest";
import { useAdminHarness } from "../support/harness.ts";

const h = useAdminHarness();

type Db = Awaited<ReturnType<typeof h.db>>;

/** Every key of an InviteView, and nothing else: no token and no token hash can ride along in an answer. */
const INVITE_VIEW_KEYS = ["createdAt", "createdBy", "email", "expiresAt", "id", "revokedAt", "siteId", "usedAt"];

const SEND_FAILED = "Email could not be sent, try again";
/** For every Resend 429 (the per-second limit, the daily quota or the monthly quota), all of which the mailer calls rate_limited. */
const EMAIL_SERVICE_LIMITED =
  "The email service is limiting how many emails we can send right now. Try again in a minute. If it still fails, today's email limit may be used up: try again after 00:00 UTC.";

/** Emails an invite and reads its token back from the outbox, as the owner's link would carry it. */
async function invited(email: string): Promise<{ id: string; tokenHash: string }> {
  const res = await h.call("POST", "/api/admin/invites", { body: { email } });
  expect(res.status).toBe(201);
  const { invite } = (await res.json()) as { invite: InviteView };
  const [mail] = await h.outbox(email);
  const token = /invite#([A-Za-z0-9_-]{43})/.exec(mail?.text ?? "")?.[1] ?? "";
  expect(token).toHaveLength(43);
  return { id: invite.id, tokenHash: await sha256Hex(token) };
}

const revokedAt = async (db: Db, id: string): Promise<number | null | undefined> =>
  (await db.prepare("SELECT revoked_at FROM invites WHERE id = ?").bind(id).first<{ revoked_at: number | null }>())?.revoked_at;

const revokeAuditRows = async (db: Db, id: string): Promise<number> =>
  (await db.prepare("SELECT id FROM audit_log WHERE action = 'invite.revoked' AND detail_json = ?").bind(JSON.stringify({ inviteId: id })).all()).results.length;

/** The owner's click, as lane A claims the token (apps/app/src/worker/routes/auth.ts:85). */
const claim = (db: Db, tokenHash: string, now: number) =>
  db.prepare("UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?").bind(now, tokenHash, now).run();

/** A send that fails: 502 email_failed with this message, the row gone, and the code (never the address) on both log lines. */
async function refusedSend(email: string, code: string, message: string): Promise<void> {
  h.server.clearLogs();
  const res = await h.call("POST", "/api/admin/invites", { body: { email } });
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: { code: "email_failed", message } });
  const rows = await (await h.db()).prepare("SELECT id FROM invites WHERE email = ?").bind(email).all();
  expect(rows.results).toEqual([]);
  // sendReporting's own line, then the request's line with the code noted on it.
  expect(h.logLines()).toEqual([
    { event: "email_failed", tag: "invite", error: code },
    { route: "POST /api/admin/invites", status: 502, ms: expect.any(Number), error: code, code: "email_failed" },
  ]);
  const raw = h.server.getLogs().map((entry) => entry.message).join("\n");
  expect(raw).not.toContain(email);
  expect(raw).not.toContain(email.slice(email.indexOf("@") + 1));
}

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
    // The fake mailer refuses this address as Plan 2's MailerError "rejected" (apps/app/test/support/fakes.ts).
    await refusedSend("someone@mail-fails.example", "rejected", SEND_FAILED);
  });

  it("tells the admin when the email service is limiting sends (rate_limited), and keeps no invite", async () => {
    // The admin's fake mailer fails this address as "rate_limited" (test/support/fakes.ts).
    await refusedSend("someone@mail-rate-limited.example", "rate_limited", EMAIL_SERVICE_LIMITED);
  });

  describe("revoke", () => {
    it("happens once: a repeat revoke answers 204 again, keeps the first revoked_at and writes no second audit row", async () => {
      const { id } = await invited("twice@example.com");
      const db = await h.db();
      expect((await h.call("DELETE", `/api/admin/invites/${id}`)).status).toBe(204);
      const first = await revokedAt(db, id);
      expect(first).toEqual(expect.any(Number));
      expect((await h.call("DELETE", `/api/admin/invites/${id}`)).status).toBe(204);
      expect(await revokedAt(db, id)).toBe(first);
      expect(await revokeAuditRows(db, id)).toBe(1);
    });

    it("changes nothing for an invite the owner has accepted (site_id set): 204, no revoked_at and no audit row", async () => {
      const { id } = await invited("accepted@example.com");
      const db = await h.db();
      // What lane A's accept batch leaves behind (apps/app/src/worker/routes/auth.ts:96-101): an owner, a site, and the invite pointing at both.
      const now = Date.now();
      const ownerId = newId();
      const siteId = newId();
      await db.prepare("INSERT INTO owners (id, email, created_at) VALUES (?, ?, ?)").bind(ownerId, "accepted@example.com", now).run();
      await db.prepare("INSERT INTO sites (id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(siteId, ownerId, now, now).run();
      await db.prepare("UPDATE invites SET used_at = ?, owner_id = ?, site_id = ? WHERE id = ?").bind(now, ownerId, siteId, id).run();
      expect((await h.call("DELETE", `/api/admin/invites/${id}`)).status).toBe(204);
      expect(await revokedAt(db, id)).toBeNull();
      expect(await revokeAuditRows(db, id)).toBe(0);
    });

    it("still revokes an invite the owner has claimed but not finished (used_at set, site_id NULL), so a rolled-back accept cannot reopen it", async () => {
      const { id, tokenHash } = await invited("claimed@example.com");
      const db = await h.db();
      expect((await claim(db, tokenHash, Date.now())).meta.changes).toBe(1);
      expect((await h.call("DELETE", `/api/admin/invites/${id}`)).status).toBe(204);
      expect(await revokedAt(db, id)).toEqual(expect.any(Number));
      expect(await revokeAuditRows(db, id)).toBe(1);
      // The accept's batch fails and releases the token (apps/app/src/worker/routes/auth.ts:121) ...
      expect((await db.prepare("UPDATE invites SET used_at = NULL WHERE id = ? AND site_id IS NULL").bind(id).run()).meta.changes).toBe(1);
      // ... and the owner's next click finds the invite revoked.
      expect((await claim(db, tokenHash, Date.now())).meta.changes).toBe(0);
    });

    it("answers 404 for an unknown invite and writes no audit row", async () => {
      const unknown = "00000000-0000-4000-8000-000000000000";
      expect((await h.call("DELETE", `/api/admin/invites/${unknown}`)).status).toBe(404);
      expect(await revokeAuditRows(await h.db(), unknown)).toBe(0);
    });
  });
});
