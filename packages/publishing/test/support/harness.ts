import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EMPTY_EDITS, newId, type OwnerEdits } from "@asksite/core";
import { SiteDocument } from "@asksite/site-schema";
import { createTestHarness } from "wrangler";

/** The bindings the publishing functions use, backed by real local D1 and R2 (workerd). */
export interface PublishEnv {
  DB: D1Database;
  WORK: R2Bucket;
  LIVE: R2Bucket;
  MEDIA: R2Bucket;
  ROOT_DOMAIN: string;
}

export const ROOT = "asksite.example";

export function publishingHarness(name: string) {
  const server = createTestHarness({
    root: resolve(import.meta.dirname, "../../../.."),
    workers: [
      {
        config: {
          name,
          main: "packages/core/test/support/noop-worker.ts",
          compatibility_date: "2026-09-21",
          d1_databases: [{ binding: "DB", database_name: "asksite", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: "packages/core/migrations" }],
          r2_buckets: [
            { binding: "WORK", bucket_name: "asksite-work" },
            { binding: "LIVE", bucket_name: "asksite-live" },
            { binding: "MEDIA", bucket_name: "asksite-media" },
          ],
        },
      },
    ],
  });
  return {
    server,
    async start(): Promise<PublishEnv> {
      await server.listen();
      const worker = server.getWorker<Omit<PublishEnv, "ROOT_DOMAIN">>();
      await worker.applyD1Migrations("DB");
      return { ...(await worker.getEnv()), ROOT_DOMAIN: ROOT };
    },
  };
}

let counter = 0;

/** A fresh owner and site with a slug. Each test gets its own ids and slug, so tests never share rows. */
export async function seedSite(db: D1Database): Promise<{ ownerId: string; siteId: string; slug: string }> {
  counter += 1;
  const ownerId = newId();
  const siteId = newId();
  const slug = `site-${counter}-${siteId.slice(0, 8)}`;
  await db.batch([
    db.prepare("INSERT INTO owners (id, email, created_at) VALUES (?, ?, 1)").bind(ownerId, `${ownerId}@example.com`),
    db.prepare("INSERT INTO sites (id, owner_id, slug, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").bind(siteId, ownerId, slug),
  ]);
  return { ownerId, siteId, slug };
}

/** A Plan 1 fixture, parsed. Read by path (not through fixtures/index.ts, whose node:fs + URL calls do
 *  not type-check next to the Workers runtime types in tsconfig.workers.json). */
export function doc(name: "plumber-austin" | "hvac-phoenix" | "cleaning-minimal" | "electrical-xss" | "roofing-extreme" = "plumber-austin"): SiteDocument {
  const path = resolve(import.meta.dirname, "../../../../fixtures", `${name}.json`);
  return SiteDocument.parse(JSON.parse(readFileSync(path, "utf8")));
}

export const EDITS: OwnerEdits = EMPTY_EDITS;

export async function auditActions(db: D1Database, siteId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT action FROM audit_log WHERE site_id = ? ORDER BY id").bind(siteId).all<{ action: string }>();
  return results.map((r) => r.action);
}

export async function siteRow(db: D1Database, siteId: string) {
  return db
    .prepare("SELECT live_version_id, pending_version_id, indexable, taken_down_at, takedown_reason FROM sites WHERE id = ?")
    .bind(siteId)
    .first<{ live_version_id: string | null; pending_version_id: string | null; indexable: number; taken_down_at: number | null; takedown_reason: string | null }>();
}

export async function versionRow(db: D1Database, versionId: string) {
  return db.prepare("SELECT * FROM site_versions WHERE id = ?").bind(versionId).first<Record<string, unknown>>();
}
