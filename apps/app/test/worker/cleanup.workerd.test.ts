import { describe, expect, it } from "vitest";
import { useAppHarness } from "../support/harness.ts";

const h = useAppHarness();

describe("daily cleanup", () => {
  it("deletes expired sessions and day-old login tokens, and keeps the rest", async () => {
    const owner = await h.signIn();
    const db = await h.db();
    const now = Date.now();
    await db.prepare("INSERT INTO sessions (id_hash, owner_id, created_at, expires_at, last_seen_at) VALUES ('old', ?, 1, 2, 1)").bind(owner.ownerId).run();
    await db.prepare("INSERT INTO login_tokens (token_hash, owner_id, created_at, expires_at) VALUES ('day-old', ?, ?, ?)").bind(owner.ownerId, now - 90_000_000, now - 89_000_000).run();
    await db.prepare("INSERT INTO login_tokens (token_hash, owner_id, created_at, expires_at) VALUES ('recent', ?, ?, ?)").bind(owner.ownerId, now - 3_600_000, now - 2_700_000).run();
    await h.server.getWorker().scheduled({ cron: "0 6 * * *", scheduledTime: new Date() });
    const sessions = await db.prepare("SELECT id_hash FROM sessions WHERE owner_id = ?").bind(owner.ownerId).all<{ id_hash: string }>();
    expect(sessions.results.map((s) => s.id_hash)).not.toContain("old");
    expect(sessions.results).toHaveLength(1);
    const tokens = await db.prepare("SELECT token_hash FROM login_tokens WHERE owner_id = ?").bind(owner.ownerId).all<{ token_hash: string }>();
    expect(tokens.results.map((t) => t.token_hash)).toEqual(["recent"]);
    expect((await h.call("GET", "/api/me", { cookie: owner.cookie })).status).toBe(200);
  });

  // P4-21: the backstop for a site that never uploads again (its next upload's pre-check ages them out too).
  it("turns upload reservations older than 10 minutes into counted failures, and leaves younger ones and photos alone", async () => {
    const owner = await h.signIn();
    const db = await h.db();
    const now = Date.now();
    const staleMs = 10 * 60_000; // DECIDED P4-21
    const row = async (reservedAt: number | null, deletedAt: number | null, width = 0) => {
      const id = crypto.randomUUID();
      await db
        .prepare("INSERT INTO uploads (id, site_id, width, height, bytes, created_at, deleted_at, reserved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, owner.siteId, width, width, width, reservedAt ?? 1, deletedAt, reservedAt)
        .run();
      return id;
    };
    const stale = await row(now - staleMs - 60_000, null);
    const purged = await row(now - staleMs - 60_000, 5);
    const young = await row(now - staleMs + 60_000, null);
    const photo = await row(null, null, 400);
    const deletedPhoto = await row(null, 7, 400);
    h.server.clearLogs();
    await h.server.getWorker().scheduled({ cron: "0 6 * * *", scheduledTime: new Date() });
    const { results } = await db.prepare("SELECT id, deleted_at, reserved_at FROM uploads WHERE site_id = ?").bind(owner.siteId).all<{ id: string; deleted_at: number | null; reserved_at: number | null }>();
    const byId = new Map(results.map((r) => [r.id, { deleted_at: r.deleted_at, reserved_at: r.reserved_at }]));
    expect(byId.get(stale)?.reserved_at).toBeNull();
    expect(byId.get(stale)?.deleted_at).toBeGreaterThanOrEqual(now);
    expect(byId.get(purged)).toEqual({ deleted_at: 5, reserved_at: null });
    expect(byId.get(young)).toEqual({ deleted_at: null, reserved_at: now - staleMs + 60_000 });
    expect(byId.get(photo)).toEqual({ deleted_at: null, reserved_at: null });
    expect(byId.get(deletedPhoto)).toEqual({ deleted_at: 7, reserved_at: null });
    expect(h.logLines().filter((line) => line["event"] === "cleanup")).toEqual([expect.objectContaining({ staleUploads: 2 })]);
  });
});
