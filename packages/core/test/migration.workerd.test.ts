import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { EMPTY_EDITS, OwnerEdits } from "../src/index.ts";

// Applies packages/core/migrations to a real local D1 (workerd through wrangler's test harness)
// and proves the constraints the rest of the system relies on.
const WORKER = {
  name: "core-migration-test",
  main: "packages/core/test/support/noop-worker.ts",
  compatibility_date: "2026-09-21",
  compatibility_flags: ["no_nodejs_compat", "no_nodejs_compat_v2"], // A13
  d1_databases: [
    { binding: "DB", database_name: "asksite", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: "packages/core/migrations" },
  ],
};
const server = createTestHarness({ root: resolve(import.meta.dirname, "../../.."), workers: [{ config: WORKER }] });

// Typed loosely on purpose: this file is type-checked without the Workers runtime types.
let db: { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<{ meta: { changes: number } }>; first<T>(): Promise<T | null> }; all<T>(): Promise<{ results: T[] }> } };

beforeAll(async () => {
  await server.listen();
  const worker = server.getWorker();
  await worker.applyD1Migrations("DB");
  db = (await worker.getEnv()).DB;
}, 120_000);
afterAll(async () => {
  await server.close();
});

/** A fresh id, slug or token for one test, so a test never meets a row an earlier run left (A9b: --repeats). */
const fresh = (): string => crypto.randomUUID();

/**
 * A new owner and a new site (fresh ids, default columns) for one test. Every test sets up its own
 * rows with fresh ids, slugs and tokens, so each passes alone (-t), in any order (A9) and again
 * against the same database (vitest --repeats, A9b).
 */
async function newSite(): Promise<{ owner: string; site: string }> {
  const owner = fresh();
  const site = fresh();
  await db.prepare("INSERT INTO owners (id, email, created_at) VALUES (?, ?, ?)").bind(owner, `${owner}@example.com`, 1).run();
  await db.prepare("INSERT INTO sites (id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(site, owner, 1, 1).run();
  return { owner, site };
}

// A13: from compatibility date 2026-08-04 Workers turn nodejs_compat and nodejs_compat_v2 on by default, so the harness
// opts out of both, and no flag starting with "nodejs" (such as nodejs_compat_populate_process_env) may come back.
describe("the harness Worker (A13)", () => {
  it("opts out of Node.js compatibility and sets no flag starting with nodejs", () => {
    expect(WORKER.compatibility_flags).toEqual(expect.arrayContaining(["no_nodejs_compat", "no_nodejs_compat_v2"]));
    expect(WORKER.compatibility_flags.filter((flag) => flag.startsWith("nodejs"))).toEqual([]);
  });

  it("runs without Node.js's process", async () => {
    expect(await (await server.fetch("https://probe.localhost/")).text()).toBe("undefined");
  });
});

describe("0001_init.sql", () => {
  it("creates every table", async () => {
    const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY name").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([
      "audit_log", "dev_outbox", "generations", "invites", "leads", "login_tokens", "owners", "sessions", "settings", "site_versions", "sites", "uploads",
    ]);
  });

  it("makes every table STRICT (A9)", async () => {
    const { results } = await db.prepare("PRAGMA table_list").all<{ name: string; strict: number }>();
    const ours = results.filter((t) => !/^(sqlite_|_cf_|d1_migrations$)/.test(t.name));
    expect(ours).toHaveLength(12);
    expect(ours.filter((t) => t.strict !== 1).map((t) => t.name)).toEqual([]);
  });

  it("refuses a value of the wrong type instead of storing it (STRICT, A9)", async () => {
    const { owner, site } = await newSite();
    const refused = /SQLITE_CONSTRAINT_DATATYPE/;
    const id = fresh();
    await expect(db.prepare("INSERT INTO owners (id, email, created_at) VALUES (?, ?, ?)").bind(id, `${id}@example.com`, "not-a-time").run()).rejects.toThrow(refused);
    await expect(db.prepare("UPDATE sites SET created_at = ? WHERE id = ?").bind(1.5, site).run()).rejects.toThrow(refused);
    await expect(
      db.prepare("INSERT INTO login_tokens (token_hash, owner_id, created_at, expires_at) VALUES (?, ?, 1, ?)").bind(id, owner, "2026-09-25T00:00:00Z").run(),
    ).rejects.toThrow(refused);
    await expect(
      db.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, cost_microusd, created_at) VALUES (?, ?, ?, 'first', 'failed', '{}', ?, 1)").bind(id, site, owner, 12.5).run(),
    ).rejects.toThrow(refused);
  });

  it("gives a new site the empty OwnerEdits and rev 1", async () => {
    const { site } = await newSite();
    const row = await db.prepare("SELECT edits_json, rev, indexable, slug FROM sites WHERE id = ?").bind(site).first<{ edits_json: string; rev: number; indexable: number; slug: string | null }>();
    expect(OwnerEdits.parse(JSON.parse(row?.edits_json ?? "null"))).toEqual(EMPTY_EDITS);
    expect(row).toMatchObject({ rev: 1, indexable: 1, slug: null });
  });

  it("enforces foreign keys", async () => {
    await expect(
      db.prepare("INSERT INTO sites (id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(fresh(), "no-such-owner", 1, 1).run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("allows many sites without a slug but never two with the same slug", async () => {
    const { owner } = await newSite();
    const insert = (id: string, slug: string | null) =>
      db.prepare("INSERT INTO sites (id, owner_id, slug, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").bind(id, owner, slug).run();
    const slug = `joes-${fresh()}`;
    await insert(fresh(), null);
    await insert(fresh(), slug);
    await expect(insert(fresh(), slug)).rejects.toThrow(/UNIQUE constraint failed: sites.slug/);
  });

  it("allows at most one queued or running generation per site (partial unique index)", async () => {
    const { owner, site } = await newSite();
    const insert = (id: string, status: string) =>
      db.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at) VALUES (?, ?, ?, 'first', ?, '{}', 1)").bind(id, site, owner, status).run();
    await insert(fresh(), "succeeded");
    await insert(fresh(), "queued");
    await expect(insert(fresh(), "queued")).rejects.toThrow(/UNIQUE constraint failed: generations.site_id/);
    await expect(insert(fresh(), "running")).rejects.toThrow(/UNIQUE constraint failed/);
    await insert(fresh(), "failed");
  });

  it("rejects values outside the CHECK constraints", async () => {
    const { site } = await newSite();
    await expect(db.prepare("UPDATE sites SET indexable = 2 WHERE id = ?").bind(site).run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      db.prepare("INSERT INTO leads (id, site_id, created_at, name, phone, email_status, ip_hash) VALUES (?, ?, 1, 'n', 'p', 'lost', 'h')").bind(fresh(), site).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("numbers versions uniquely per site", async () => {
    const { owner, site } = await newSite();
    const insert = (id: string, n: number) =>
      db.prepare(
        "INSERT INTO site_versions (id, site_id, number, status, document_json, document_sha256, edits_json, html_key, html_sha256, stylesheet_sha256, requested_by, requested_at) VALUES (?, ?, ?, 'pending', '{}', 'd', '{}', 'k', 'h', 's', ?, 1)",
      ).bind(id, site, n, owner).run();
    await insert(fresh(), 1);
    await expect(insert(fresh(), 1)).rejects.toThrow(/UNIQUE constraint failed: site_versions.site_id, site_versions.number/);
  });

  it("consumes a single-use token exactly once, even when two verifies race", async () => {
    const { owner } = await newSite();
    const token = fresh();
    await db.prepare("INSERT INTO login_tokens (token_hash, owner_id, created_at, expires_at) VALUES (?, ?, 1, ?)").bind(token, owner, Number.MAX_SAFE_INTEGER).run();
    const consume = () =>
      db.prepare("UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").bind(2, token, 2).run();
    const results = await Promise.all([consume(), consume(), consume()]);
    expect(results.map((r) => r.meta.changes).sort()).toEqual([0, 0, 1]);
  });
});

// A16: a version's pages. Numbered 0005 because Plan 4 holds 0003 and 0004 on its branches; the files are
// independent, and wrangler applies them by name, so a fresh database gets 0001 to 0005 in order.
describe("0005_version_pages.sql", () => {
  const insertVersion = (site: string, owner: string, pagesJson?: string | null) => {
    const id = fresh();
    const columns = "id, site_id, number, status, document_json, document_sha256, edits_json, html_key, html_sha256, stylesheet_sha256, requested_by, requested_at";
    return pagesJson === undefined
      ? db.prepare(`INSERT INTO site_versions (${columns}) VALUES (?, ?, 1, 'pending', '{}', 'd', '{}', 'k', 'h', 's', ?, 1)`).bind(id, site, owner).run().then(() => id)
      : db.prepare(`INSERT INTO site_versions (${columns}, pages_json) VALUES (?, ?, 1, 'pending', '{}', 'd', '{}', 'k', 'h', 's', ?, 1, ?)`).bind(id, site, owner, pagesJson).run().then(() => id);
  };

  it("gives a version written without pages the empty list", async () => {
    const { owner, site } = await newSite();
    const id = await insertVersion(site, owner);
    expect(await db.prepare("SELECT pages_json FROM site_versions WHERE id = ?").bind(id).first<{ pages_json: string }>()).toEqual({ pages_json: "[]" });
  });

  it("stores a page list and refuses a missing one", async () => {
    const { owner, site } = await newSite();
    const id = await insertVersion(site, owner, '[{"page":"home","sha256":"a"}]');
    expect((await db.prepare("SELECT pages_json FROM site_versions WHERE id = ?").bind(id).first<{ pages_json: string }>())?.pages_json).toBe('[{"page":"home","sha256":"a"}]');
    const other = await newSite();
    await expect(insertVersion(other.site, other.owner, null)).rejects.toThrow(/NOT NULL constraint failed: site_versions.pages_json/);
  });
});

// A16-4c: one admin action per site at a time. Numbered 0006 by the moderator; Plan 4's next migration is 0007.
describe("0006_site_admin_lock.sql", () => {
  it("adds the lease columns, empty by default", async () => {
    const { site } = await newSite();
    expect(await db.prepare("SELECT admin_lock, admin_lock_until FROM sites WHERE id = ?").bind(site).first()).toEqual({ admin_lock: null, admin_lock_until: null });
  });

  it("keeps the table STRICT: a lease of the wrong type is refused", async () => {
    const { site } = await newSite();
    await db.prepare("UPDATE sites SET admin_lock = ?, admin_lock_until = ? WHERE id = ?").bind("token", 5, site).run();
    await expect(db.prepare("UPDATE sites SET admin_lock_until = ? WHERE id = ?").bind("soon", site).run()).rejects.toThrow(/SQLITE_CONSTRAINT_DATATYPE/);
    await expect(db.prepare("UPDATE sites SET admin_lock_until = ? WHERE id = ?").bind(1.5, site).run()).rejects.toThrow(/SQLITE_CONSTRAINT_DATATYPE/);
  });
});
