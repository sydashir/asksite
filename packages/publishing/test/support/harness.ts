import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson, EMPTY_EDITS, hashPages, livePointerKey, liveSitePrefix, newId, pagesDigest, versionPageKey, VersionPages, type OwnerEdits } from "@asksite/core";
import { SiteDocument, type PageId } from "@asksite/site-schema";
import { createTestHarness } from "wrangler";
import { createPendingVersion } from "../../src/index.ts";

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
          main: "packages/publishing/test/support/runtime-worker.ts",
          compatibility_date: "2026-09-21",
          // A13: Node.js compatibility is on by default from 2026-08-04; Cloudflare turns it off with both.
          compatibility_flags: ["no_nodejs_compat", "no_nodejs_compat_v2"],
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

/** A LIVE (or WORK) bucket that delegates to `bucket`, except where `fail` says a call must throw. */
export function flakyBucket(bucket: R2Bucket, fail: (call: "put" | "delete" | "list", arg: unknown) => boolean, calls: Array<{ call: string; arg: unknown }> = []): R2Bucket {
  const guarded =
    <A extends unknown[], R>(call: "put" | "delete" | "list", run: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      calls.push({ call, arg: args[0] });
      return fail(call, args[0]) ? Promise.reject(new Error("R2 is unavailable")) : run(...args);
    };
  return {
    get: (...args: Parameters<R2Bucket["get"]>) => bucket.get(...args),
    head: (key: string) => bucket.head(key),
    put: guarded("put", (...args: Parameters<R2Bucket["put"]>) => bucket.put(...args)),
    delete: guarded("delete", (keys: string | string[]) => bucket.delete(keys)),
    list: guarded("list", (options?: R2ListOptions) => bucket.list(options)),
  } as unknown as R2Bucket;
}

/** Every LIVE key of one site: its pointer and the objects under its prefix (never another site's). */
export async function liveKeysOf(live: R2Bucket, slug: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await live.list(cursor === undefined ? { prefix: slug } : { prefix: slug, cursor });
    keys.push(...page.objects.map((o) => o.key).filter((key) => key === livePointerKey(slug) || key.startsWith(liveSitePrefix(slug))));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return keys.sort();
}

/**
 * A version with several pages, built by hand with the real core helpers (the renderer gives one page for now):
 * a real pending version, then its WORK pages and its row's pages_json, digest and Home key replaced.
 */
export async function pendingWithPages(env: PublishEnv, pages: readonly PageId[] = ["home", "services", "contact"]) {
  const site = await seedSite(env.DB);
  const version = await createPendingVersion(env, { ...site, document: doc(), edits: EDITS, generationId: null, now: 10 });
  const built = await hashPages(pages.map((page) => ({ page, html: `<!DOCTYPE html><title>${page} of ${version.id}</title><p>${page}</p>` })));
  await Promise.all(built.map((p) => env.WORK.put(versionPageKey(site.siteId, version.id, p.page), p.html, { customMetadata: { siteId: site.siteId, versionId: version.id, page: p.page, sha256: p.sha256 } })));
  const list = VersionPages.parse(built.map(({ page, sha256 }) => ({ page, sha256 })));
  const digest = await pagesDigest(list);
  await env.DB.prepare("UPDATE site_versions SET pages_json = ?, html_sha256 = ? WHERE id = ?").bind(canonicalJson(list), digest, version.id).run();
  return { ...site, versionId: version.id, htmlSha256: digest, pages: built };
}
