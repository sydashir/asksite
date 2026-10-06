import { fileURLToPath } from "node:url";
import type { GenerationRow } from "@asksite/core";
import type { D1Database } from "@cloudflare/workers-types";
import { createTestHarness } from "wrangler";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export interface LocalD1 {
  /** The D1 binding, once workerd is up and packages/core/migrations are applied. */
  ready: Promise<D1Database>;
  /** Stops workerd, also while it is still starting (wrangler's close waits for the start, then tears it down). */
  close(): Promise<void>;
}

/** The harness Worker's config; settings.workerd.test.ts asserts its A13 flags (global constraint K). */
export const LOCAL_D1_WORKER = {
  name: "generation-test-db",
  main: "./packages/generation/test/support/noop-worker.ts",
  compatibility_date: "2026-09-21",
  compatibility_flags: ["no_nodejs_compat", "no_nodejs_compat_v2"], // A13
  d1_databases: [{ binding: "DB", database_name: "asksite", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: "./packages/core/migrations" }],
};

/**
 * A real local D1 (Miniflare, via wrangler's test harness). It returns at once, before awaiting listen, so a file's
 * afterAll holds the closer even when its beforeAll timed out waiting for `ready`; otherwise workerd outlives the run
 * (Task 9 follow-up item 4). Use: `local = startLocalD1(); db = await local.ready;` and `afterAll(() => local?.close())`.
 */
export function startLocalD1(): LocalD1 {
  const server = createTestHarness({ root: ROOT, workers: [{ config: LOCAL_D1_WORKER }] });
  const ready = (async () => {
    await server.listen();
    const worker = server.getWorker();
    await worker.applyD1Migrations("DB");
    return ((await worker.getEnv()) as { DB: D1Database }).DB;
  })();
  return {
    ready,
    close: async () => {
      void ready.catch(() => undefined); // once closing, a start cut short is expected, not an unhandled rejection
      await server.close();
    },
  };
}

export async function clearTables(db: D1Database): Promise<void> {
  await db.batch(["audit_log", "generations", "settings", "sites", "owners"].map((table) => db.prepare(`DELETE FROM ${table}`)));
}

export async function seedOwnerSite(db: D1Database, ownerId: string, siteId: string): Promise<void> {
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO owners (id, email, created_at) VALUES (?1, ?2, 0)").bind(ownerId, `${ownerId}@example.com`),
    db.prepare("INSERT INTO sites (id, owner_id, created_at, updated_at) VALUES (?1, ?2, 0, 0)").bind(siteId, ownerId),
  ]);
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at, updated_by) VALUES (?1, ?2, 0, 'test')").bind(key, value).run();
}

/** Inserts a generation row directly; unspecified columns take the table defaults. */
export async function insertGeneration(db: D1Database, row: Partial<GenerationRow> & Pick<GenerationRow, "id" | "site_id" | "owner_id">): Promise<void> {
  const full = { kind: "first", status: "queued", input_json: "{}", created_at: 0, ...row };
  const columns = Object.keys(full);
  await db
    .prepare(`INSERT INTO generations (${columns.join(", ")}) VALUES (${columns.map((_, i) => `?${i + 1}`).join(", ")})`)
    .bind(...Object.values(full))
    .run();
}

export async function getGeneration(db: D1Database, id: string): Promise<GenerationRow> {
  const row = await db.prepare("SELECT * FROM generations WHERE id = ?1").bind(id).first<GenerationRow>();
  if (row === null) throw new Error(`no generation ${id}`);
  return row;
}

/**
 * The same D1 with the first `times` .run() of each statement whose SQL matches `sql` throwing `message`, as D1 does on a
 * transient error (the statement is not executed). Everything else, batch included, goes to the real binding. `runs` counts
 * every .run() of a matching statement, failed or not.
 */
export function failingRuns(real: D1Database, sql: RegExp, message: string, times = 1): { db: D1Database; runs: () => number } {
  let runs = 0;
  let failed = 0;
  const db = {
    prepare: (text: string) => {
      const statement = real.prepare(text);
      if (!sql.test(text)) return statement;
      const wrap = (inner: ReturnType<D1Database["prepare"]>): ReturnType<D1Database["prepare"]> =>
        ({
          bind: (...values: unknown[]) => wrap(inner.bind(...values)),
          run: async () => {
            runs += 1;
            if (failed < times) {
              failed += 1;
              throw new Error(message);
            }
            return inner.run();
          },
        }) as unknown as ReturnType<D1Database["prepare"]>;
      return wrap(statement);
    },
    batch: (statements: Parameters<D1Database["batch"]>[0]) => real.batch(statements),
  } as unknown as D1Database;
  return { db, runs: () => runs };
}
