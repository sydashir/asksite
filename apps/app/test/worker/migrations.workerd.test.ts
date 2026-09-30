import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import type { D1Like } from "../support/harness.ts";

// P4-21's migrations (the moderator's exception for lane A: 0003 and 0004 in packages/core/migrations), applied by
// wrangler's own migration step to a real local D1 whose tables already hold rows, as production's will. Everything
// after 0001 is first marked as applied in wrangler's migrations table, so the step applies 0001 alone; rows are
// written; then the marks are removed and the same step applies the rest onto those rows.
const MIGRATIONS = new URL("../../../../packages/core/migrations/", import.meta.url);
const FIRST = "0001_init.sql";
const LATER = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith(".sql") && name !== FIRST)
  .sort();

// Wrangler's own statement for its migrations table (d1_migrations, the default name: developers.cloudflare.com/d1/reference/migrations/).
const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS d1_migrations(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

const server = createTestHarness({ workers: [{ configPath: new URL("../wrangler.test.jsonc", import.meta.url) }] });
let db: D1Like;

/** The ids of the rows written between 0001 and the later migrations. */
const OWNER = "owner-before-p4-21";
const SITE = "site-before-p4-21";
const PHOTO = "photo-before-p4-21";
const FAILED = "failure-before-p4-21";
const VERSION = "version-before-p4-21";

/** Each column of a table: name, declared type, NOT NULL and default. */
async function columns(table: string): Promise<Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>> {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).bind().all<{ name: string; type: string; notnull: number; dflt_value: unknown }>();
  return results.map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }));
}

beforeAll(async () => {
  await server.listen();
  db = ((await server.getWorker().getEnv()) as { DB: D1Like }).DB;
  await db.prepare(CREATE_MIGRATIONS_TABLE).bind().run();
  for (const name of LATER) await db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(name).run();
  await server.getWorker().applyD1Migrations("DB");
  // The step really applied 0001 alone: the column 0003 adds is not there yet.
  if ((await columns("uploads")).some((column) => column.name === "reserved_at")) throw new Error("a later migration ran before the rows were written");

  await db.prepare("INSERT INTO owners (id, email, created_at) VALUES (?, ?, 1)").bind(OWNER, "before@example.com").run();
  await db.prepare("INSERT INTO sites (id, owner_id, created_at, updated_at) VALUES (?, ?, 1, 1)").bind(SITE, OWNER).run();
  const upload = "INSERT INTO uploads (id, site_id, width, height, bytes, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)";
  await db.prepare(upload).bind(PHOTO, SITE, 1600, 1200, 123_456, 10, null).run();
  await db.prepare(upload).bind(FAILED, SITE, 0, 0, 0, 20, 20).run();
  await db
    .prepare(
      "INSERT INTO site_versions (id, site_id, number, status, document_json, document_sha256, edits_json, html_key, html_sha256, stylesheet_sha256, requested_by, requested_at) VALUES (?, ?, 1, 'pending', '{}', 'd', '{}', 'k', 'h', 's', ?, 30)",
    )
    .bind(VERSION, SITE, OWNER)
    .run();

  for (const name of LATER) await db.prepare("DELETE FROM d1_migrations WHERE name = ?").bind(name).run();
  await server.getWorker().applyD1Migrations("DB");
}, 120_000);
afterAll(async () => {
  await server.close();
});

describe("P4-21's migrations, applied onto tables that already hold rows", () => {
  it("are all applied, in order", async () => {
    const applied = (await db.prepare("SELECT name FROM d1_migrations ORDER BY id").bind().all<{ name: string }>()).results.map((row) => row.name);
    expect(applied).toEqual([FIRST, ...LATER]);
  });

  it("hold one change each (DECIDED web-maker-f4): 0003 adds uploads.reserved_at, 0004 the covering index", () => {
    /** A migration's SQL without its comment lines, whitespace collapsed. */
    const statements = (name: string) =>
      readFileSync(new URL(name, MIGRATIONS), "utf8")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    expect(statements("0003_upload_reservations.sql")).toBe("ALTER TABLE uploads ADD COLUMN reserved_at INTEGER;");
    expect(statements("0004_site_versions_requested.sql")).toBe("CREATE INDEX site_versions_requested ON site_versions(requested_at, site_id, number);");
  });

  it("keep uploads STRICT, add reserved_at as a nullable INTEGER with no default, and leave every existing row as it was, with reserved_at NULL", async () => {
    const tables = (await db.prepare("PRAGMA table_list").bind().all<{ name: string; strict: number }>()).results;
    expect(tables.find((table) => table.name === "uploads")?.strict).toBe(1);
    expect((await columns("uploads")).find((column) => column.name === "reserved_at")).toEqual({ name: "reserved_at", type: "INTEGER", notnull: 0, dflt_value: null });
    const rows = await db.prepare("SELECT id, width, height, bytes, created_at, deleted_at, reserved_at FROM uploads WHERE site_id = ? ORDER BY created_at").bind(SITE).all();
    expect(rows.results).toEqual([
      { id: PHOTO, width: 1600, height: 1200, bytes: 123_456, created_at: 10, deleted_at: null, reserved_at: null },
      { id: FAILED, width: 0, height: 0, bytes: 0, created_at: 20, deleted_at: 20, reserved_at: null },
    ]);
    // STRICT covers the new column too.
    await expect(db.prepare("UPDATE uploads SET reserved_at = ? WHERE id = ?").bind("soon", PHOTO).run()).rejects.toThrow(/SQLITE_CONSTRAINT_DATATYPE/);
  });

  it("index site_versions on (requested_at, site_id, number) and leave its existing rows as they were", async () => {
    const indexed = await db.prepare("PRAGMA index_info(site_versions_requested)").bind().all<{ seqno: number; name: string }>();
    expect(indexed.results.sort((a, b) => a.seqno - b.seqno).map((column) => column.name)).toEqual(["requested_at", "site_id", "number"]);
    expect(await db.prepare("SELECT id, number, requested_at FROM site_versions WHERE site_id = ?").bind(SITE).all()).toMatchObject({
      results: [{ id: VERSION, number: 1, requested_at: 30 }],
    });
  });
});
