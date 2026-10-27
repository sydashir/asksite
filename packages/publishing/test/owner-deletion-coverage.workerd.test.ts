import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OWNER_DELETION_KEEPS, OWNER_DELETION_TABLES } from "../src/owner-deletion.ts";
import { publishingHarness, type PublishEnv } from "./support/harness.ts";

// The guard against the next new table (moderator review of de9584c, I1): 0012 added orders, which reference sites, and
// account deletion did not delete them, so deleting a shop that had taken an order failed on the foreign key (D1 enforces
// foreign keys: developers.cloudflare.com/d1/sql-api/foreign-keys) and kept buyers' data. After every migration, each
// table that names a site or an owner (a site_id or owner_id column, or a foreign key to sites or owners) must be one
// account deletion deletes, or be kept on purpose with a reason.

const harness = publishingHarness("publishing-owner-deletion-coverage-test");
let env: PublishEnv;
beforeAll(async () => {
  env = await harness.start();
}, 120_000);
afterAll(async () => {
  await harness.server.close();
});

async function tablesNamingASiteOrOwner(): Promise<string[]> {
  const { results: tables } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY name",
  ).all<{ name: string }>();
  const naming: string[] = [];
  for (const { name } of tables) {
    const columns = (await env.DB.prepare(`PRAGMA table_info(${name})`).all<{ name: string }>()).results.map((c) => c.name);
    const foreignKeys = (await env.DB.prepare(`PRAGMA foreign_key_list(${name})`).all<{ table: string }>()).results.map((f) => f.table);
    if (columns.includes("site_id") || columns.includes("owner_id") || foreignKeys.includes("sites") || foreignKeys.includes("owners")) naming.push(name);
  }
  return naming;
}

describe("account deletion covers every table that names a site or an owner", () => {
  it("finds the tables it guards (the check itself works)", async () => {
    expect(await tablesNamingASiteOrOwner()).toEqual(expect.arrayContaining(["leads", "orders", "sessions", "sites", "uploads"]));
  });

  it("each such table is deleted by deleteOwner or kept on purpose with a reason", async () => {
    const uncovered = (await tablesNamingASiteOrOwner()).filter((table) => !OWNER_DELETION_TABLES.includes(table) && !Object.hasOwn(OWNER_DELETION_KEEPS, table));
    expect(uncovered).toEqual([]);
    for (const reason of Object.values(OWNER_DELETION_KEEPS)) expect(reason.length).toBeGreaterThan(20);
  });
});
