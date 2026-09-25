import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { EMPTY_EDITS, OwnerEdits } from "../src/index.ts";

// Applies packages/core/migrations to a real local D1 (workerd through wrangler's test harness)
// and proves the constraints the rest of the system relies on.
const server = createTestHarness({
  root: resolve(import.meta.dirname, "../../.."),
  workers: [
    {
      config: {
        name: "core-migration-test",
        main: "packages/core/test/support/noop-worker.ts",
        compatibility_date: "2026-09-21",
        d1_databases: [
          { binding: "DB", database_name: "asksite", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: "packages/core/migrations" },
        ],
      },
    },
  ],
});

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

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SITE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("0001_init.sql", () => {
  it("creates every table", async () => {
    const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY name").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([
      "audit_log", "dev_outbox", "generations", "invites", "leads", "login_tokens", "owners", "sessions", "settings", "site_versions", "sites", "uploads",
    ]);
  });

  it("gives a new site the empty OwnerEdits and rev 1", async () => {
    await db.prepare("INSERT INTO owners (id, email, created_at) VALUES (?, ?, ?)").bind(OWNER, "owner@example.com", 1).run();
    await db.prepare("INSERT INTO sites (id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(SITE, OWNER, 1, 1).run();
    const row = await db.prepare("SELECT edits_json, rev, indexable, slug FROM sites WHERE id = ?").bind(SITE).first<{ edits_json: string; rev: number; indexable: number; slug: string | null }>();
    expect(OwnerEdits.parse(JSON.parse(row?.edits_json ?? "null"))).toEqual(EMPTY_EDITS);
    expect(row).toMatchObject({ rev: 1, indexable: 1, slug: null });
  });

  it("enforces foreign keys", async () => {
    await expect(
      db.prepare("INSERT INTO sites (id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?)").bind("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "no-such-owner", 1, 1).run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("allows many sites without a slug but never two with the same slug", async () => {
    const insert = (id: string, slug: string | null) =>
      db.prepare("INSERT INTO sites (id, owner_id, slug, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").bind(id, OWNER, slug).run();
    await insert("dddddddd-dddd-4ddd-8ddd-dddddddddddd", null);
    await insert("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "joes");
    await expect(insert("ffffffff-ffff-4fff-8fff-ffffffffffff", "joes")).rejects.toThrow(/UNIQUE constraint failed: sites.slug/);
  });

  it("allows at most one queued or running generation per site (partial unique index)", async () => {
    const insert = (id: string, status: string) =>
      db.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at) VALUES (?, ?, ?, 'first', ?, '{}', 1)").bind(id, SITE, OWNER, status).run();
    await insert("10000000-0000-4000-8000-000000000001", "succeeded");
    await insert("10000000-0000-4000-8000-000000000002", "queued");
    await expect(insert("10000000-0000-4000-8000-000000000003", "queued")).rejects.toThrow(/UNIQUE constraint failed: generations.site_id/);
    await expect(insert("10000000-0000-4000-8000-000000000004", "running")).rejects.toThrow(/UNIQUE constraint failed/);
    await insert("10000000-0000-4000-8000-000000000005", "failed");
  });

  it("rejects values outside the CHECK constraints", async () => {
    await expect(db.prepare("UPDATE sites SET indexable = 2 WHERE id = ?").bind(SITE).run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      db.prepare("INSERT INTO leads (id, site_id, created_at, name, phone, email_status, ip_hash) VALUES ('l1', ?, 1, 'n', 'p', 'lost', 'h')").bind(SITE).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it("numbers versions uniquely per site", async () => {
    const insert = (id: string, n: number) =>
      db.prepare(
        "INSERT INTO site_versions (id, site_id, number, status, document_json, document_sha256, edits_json, html_key, html_sha256, stylesheet_sha256, requested_by, requested_at) VALUES (?, ?, ?, 'pending', '{}', 'd', '{}', 'k', 'h', 's', ?, 1)",
      ).bind(id, SITE, n, OWNER).run();
    await insert("20000000-0000-4000-8000-000000000001", 1);
    await expect(insert("20000000-0000-4000-8000-000000000002", 1)).rejects.toThrow(/UNIQUE constraint failed: site_versions.site_id, site_versions.number/);
  });

  it("consumes a single-use token exactly once, even when two verifies race", async () => {
    await db.prepare("INSERT INTO login_tokens (token_hash, owner_id, created_at, expires_at) VALUES ('t1', ?, 1, ?)").bind(OWNER, Number.MAX_SAFE_INTEGER).run();
    const consume = () =>
      db.prepare("UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").bind(2, "t1", 2).run();
    const results = await Promise.all([consume(), consume(), consume()]);
    expect(results.map((r) => r.meta.changes).sort()).toEqual([0, 0, 1]);
  });
});
