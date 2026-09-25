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
});
