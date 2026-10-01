import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { livePageKey, livePointerKey, mediaKey, newId } from "@asksite/core";
import type { PageId } from "@asksite/site-schema";
import { createTestHarness } from "wrangler";
import type { Env } from "../../src/env.ts";

export const ROOT = "localhost:8789";

// Every variable and secret the Worker reads is set here. Harness values beat a developer's
// .dev.vars, so a local .dev.vars (even one with a real Resend key) can never leak into tests.
export const TEST_VARS = {
  ENVIRONMENT: "development",
  ROOT_DOMAIN: ROOT,
  MAILER: "log",
  MAIL_FROM: "asksite test <test@localhost>",
  SECURITY_TXT_EXPIRES: "2027-09-24T00:00:00.000Z",
  LEAD_EMAILS_PER_DAY: "40", // the production value (lead-cap.workerd.test.ts checks they match)
};
export const TEST_SECRETS = { IP_HASH_KEY: "test-only-ip-hash-key", RESEND_API_KEY: "" };

/** Bindings the other Workers own (WORK is never bound to asksite-sites), for seeding and pipeline tests. */
export interface ToolsEnv {
  DB: D1Database;
  WORK: R2Bucket;
  LIVE: R2Bucket;
  MEDIA: R2Bucket;
}

const REPO = resolve(import.meta.dirname, "../../../..");
// The tools Worker must name the same database id as asksite-sites to share its local D1, whatever
// id wrangler.jsonc holds (the placeholder now, the real id after the deploy task).
const SITES_CONFIG = JSON.parse(readFileSync(resolve(REPO, "apps/sites/wrangler.jsonc"), "utf8")) as { d1_databases: Array<{ database_id: string }> };
const DATABASE_ID = SITES_CONFIG.d1_databases[0]?.database_id ?? "";

/** asksite-sites from its real wrangler.jsonc, plus a "tools" Worker sharing its D1 and R2 storage. */
export function sitesHarness(overrides: { vars?: Record<string, string>; secrets?: Record<string, string> } = {}) {
  const server = createTestHarness({
    root: REPO,
    workers: [
      {
        configPath: "apps/sites/wrangler.jsonc",
        vars: { ...TEST_VARS, ...overrides.vars },
        secrets: { ...TEST_SECRETS, ...overrides.secrets },
      },
      {
        config: {
          name: "tools",
          main: "packages/core/test/support/noop-worker.ts",
          compatibility_date: "2026-09-21",
          // A13: Node.js compatibility is on by default from 2026-08-04; Cloudflare turns it off with both.
          compatibility_flags: ["no_nodejs_compat", "no_nodejs_compat_v2"],
          d1_databases: [{ binding: "DB", database_name: "asksite", database_id: DATABASE_ID, migrations_dir: "packages/core/migrations" }],
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
    async start(): Promise<{ sites: Env; tools: ToolsEnv }> {
      await server.listen();
      const tools = server.getWorker<ToolsEnv>("tools");
      await tools.applyD1Migrations("DB");
      return { sites: await server.getWorker<Env>("asksite-sites").getEnv(), tools: await tools.getEnv() };
    },
  };
}

export const at = (slug: string, path = "/") => `https://${slug}.${ROOT}${path}`;

type LogLine = Record<string, unknown>;

/** The sites Worker's JSON log lines since the harness started or the last clearLogs(). */
export function sitesLines(h: ReturnType<typeof sitesHarness>): LogLine[] {
  return h.server.getLogs().flatMap((entry) => {
    try {
      const line: unknown = JSON.parse(entry.message);
      return typeof line === "object" && line !== null && (line as LogLine)["worker"] === "asksite-sites" ? [line as LogLine] : [];
    } catch {
      return [];
    }
  });
}

/** The log lines whose `key` is `value`, once at least `count` of them have arrived (logs reach the harness after the response). */
export async function linesWith(h: ReturnType<typeof sitesHarness>, key: string, value: string, count: number): Promise<LogLine[]> {
  for (let attempt = 0; attempt < 100 && sitesLines(h).filter((line) => line[key] === value).length < count; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return sitesLines(h).filter((line) => line[key] === value);
}

let counter = 0;

export interface SeededSite { ownerId: string; ownerEmail: string; siteId: string; slug: string; html: string; versionId: string | null }

/** The business phone approveVersion adds to the LIVE pointer's metadata (A15), here plumber-austin's. */
export const PHONE_METADATA = { phoneText: "(512) 555-0142", phoneTel: "+15125550142" };
/** Everything approveVersion adds about the business: the phone and the name (QA-2 RU(2)), plumber-austin's. */
export const BUSINESS_METADATA = { businessName: "Reliable Rooter Plumbing", ...PHONE_METADATA };

/** The version a pointer and pages name when the site has no live version in D1 (a draft whose LIVE objects exist anyway). */
export const DRAFT_VERSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** An owner and a site. By default the site is live (a live version id, a LIVE pointer and Home's page) and indexable.
 *  The pointer carries the metadata approveVersion writes, which the Worker checks (Decision 24), plus
 *  `metadata` (e.g. PHONE_METADATA); without the phone it is a pointer written before A15 stored it. */
export async function seedSite(
  env: ToolsEnv,
  options: { live?: boolean; indexable?: boolean; takenDown?: boolean; withObject?: boolean; metadata?: Record<string, string> } = {},
): Promise<SeededSite> {
  const { live = true, indexable = true, takenDown = false, withObject = live, metadata = {} } = options;
  counter += 1;
  const ownerId = newId();
  const siteId = newId();
  const versionId = live ? newId() : null;
  const slug = `shop-${counter}-${siteId.slice(0, 6)}`;
  const ownerEmail = `owner-${counter}@example.com`;
  const html = `<!DOCTYPE html><html lang="en"><head><title>${slug}</title></head><body><main><h1>${slug}</h1></main></body></html>`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO owners (id, email, created_at) VALUES (?, ?, 1)").bind(ownerId, ownerEmail),
    env.DB.prepare("INSERT INTO sites (id, owner_id, slug, live_version_id, indexable, taken_down_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)")
      .bind(siteId, ownerId, slug, versionId, indexable ? 1 : 0, takenDown ? 5 : null),
  ]);
  const site = { ownerId, ownerEmail, siteId, slug, html, versionId };
  if (withObject) {
    await putLive(env, site);
    await putPointer(env, site, metadata);
  }
  return site;
}

/** Stores one page of a site's version in LIVE the way approveVersion does (Home unless `page` says otherwise):
 *  at the immutable key under the version id, with the content type and { siteId, versionId, page } metadata. */
export async function putLive(
  env: ToolsEnv,
  site: Pick<SeededSite, "slug" | "siteId" | "versionId" | "html">,
  page: PageId = "home",
): Promise<void> {
  const versionId = site.versionId ?? DRAFT_VERSION_ID;
  await env.LIVE.put(livePageKey(site.slug, versionId, page), site.html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: { siteId: site.siteId, versionId, page },
  });
}

/** Writes the site's LIVE pointer: empty, naming the site's live version (or `versionId`), plus `metadata` (the business). */
export async function putPointer(
  env: ToolsEnv,
  site: Pick<SeededSite, "slug" | "siteId" | "versionId">,
  metadata: Record<string, string> = {},
  versionId: string = site.versionId ?? DRAFT_VERSION_ID,
): Promise<void> {
  await env.LIVE.put(livePointerKey(site.slug), "", { customMetadata: { siteId: site.siteId, versionId, ...metadata } });
}

/** A site's leads once none is still 'pending': the lead email runs after the 303 (ctx.waitUntil, Decision 26). */
export async function settledLeads(env: ToolsEnv, siteId: string): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { results } = await env.DB.prepare("SELECT * FROM leads WHERE site_id = ? ORDER BY created_at").bind(siteId).all<Record<string, unknown>>();
    if (results.length > 0 && results.every((lead) => lead["email_status"] !== "pending")) return results;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`site ${siteId}: no lead, or its email never finished`);
}

/** A stored photo for a site. The R2 object's own content type is deliberately wrong: the Worker must ignore it. */
export async function seedUpload(env: ToolsEnv, siteId: string, options: { deleted?: boolean } = {}): Promise<{ uploadId: string; bytes: Uint8Array }> {
  const uploadId = newId();
  const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
  await env.DB.prepare("INSERT INTO uploads (id, site_id, width, height, bytes, created_at, deleted_at) VALUES (?, ?, 1600, 1200, ?, 1, ?)")
    .bind(uploadId, siteId, bytes.byteLength, options.deleted ? 9 : null)
    .run();
  await env.MEDIA.put(mediaKey(siteId, uploadId), bytes, { httpMetadata: { contentType: "text/html" } });
  return { uploadId, bytes };
}
