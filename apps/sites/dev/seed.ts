// pnpm dev:seed: puts an approved demo site into the LOCAL state used by `pnpm dev`, through the
// real publishing functions, so https://demo.localhost:8789/ shows a real page with photos.
// It binds D1 and R2 through wrangler's getPlatformProxy: the local state by default; with --remote,
// the production resources (the deploy smoke test only, Task 19; needs `wrangler login`).
//
// Usage: pnpm dev:seed [--slug demo] [--fixture plumber-austin] [--persist-to .wrangler/state]
//          [--root localhost:8789] [--owner-email <email>] [--hero-photo] [--noindex] [--remote]
// Prints one JSON line: {"siteId":"…","url":"https://demo.localhost:8789/","created":true}
//
// The demo's contact form keeps the production limits (A15): one visitor network may leave 3 leads a
// UTC day on a site and 5 across all sites, then gets "Please call instead" until 00:00 UTC. Without a
// CF-Connecting-IP header, local wrangler uses the loopback address a post came from (::1 or 127.0.0.1),
// so your own test posts share one visitor's limits. To post as another visitor, send the header (local
// wrangler keeps it), e.g. curl -k -H 'cf-connecting-ip: 192.0.2.7' -d 'name=Pat&phone=5125550123'
// https://demo.localhost:8789/_f/<siteId>; or start again from a fresh --persist-to folder.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EMPTY_EDITS, mediaKey, mediaUrl, newId, siteUrl, slugIssue } from "@asksite/core";
import { approveVersion, createPendingVersion } from "@asksite/publishing";
import { SiteDocument, type SiteDocumentInput } from "@asksite/site-schema";

export interface ToolsEnv {
  DB: D1Database;
  WORK: R2Bucket;
  LIVE: R2Bucket;
  MEDIA: R2Bucket;
}

/** A 16x9 grey lossless WebP (38 bytes): every demo photo, shown at 1600x900. */
export const DEMO_WEBP = Uint8Array.from(atob("UklGRh4AAABXRUJQVlA4TBEAAAAvDwACAAfQ0XL2tf+BiOh/AAA="), (c) => c.charCodeAt(0));

const REPO = resolve(import.meta.dirname, "../../..");
const SITES_DIR = join(REPO, "apps/sites");
const TOOLS_CONFIG = join(SITES_DIR, "wrangler.tools.jsonc"); // generated, gitignored

export interface SeedOptions {
  slug: string;
  fixture: string;
  persistTo: string;
  root: string;
  ownerEmail: string | null; // null: "<slug>-owner@example.com"
  heroPhoto: boolean; // add one photo to a fixture that has none (the deploy smoke test)
  indexable: boolean;
  remote: boolean; // the production D1 and R2 instead of the local state
}

export function parseSeedOptions(argv: readonly string[]): SeedOptions {
  const options: SeedOptions = {
    slug: "demo", fixture: "plumber-austin", persistTo: ".wrangler/state", root: "localhost:8789",
    ownerEmail: null, heroPhoto: false, indexable: true, remote: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i] ?? "";
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${name} needs a value`);
      return next;
    };
    if (name === "--slug") options.slug = value();
    else if (name === "--fixture") options.fixture = value();
    else if (name === "--persist-to") options.persistTo = value();
    else if (name === "--root") options.root = value();
    else if (name === "--owner-email") options.ownerEmail = value();
    else if (name === "--hero-photo") options.heroPhoto = true;
    else if (name === "--noindex") options.indexable = false;
    else if (name === "--remote") options.remote = true;
    else throw new Error(`Unknown option ${name}`);
  }
  if (!/^[a-z-]+$/.test(options.fixture)) throw new Error(`Unknown fixture ${options.fixture}`);
  return options;
}

/** The sites Worker's D1 and R2 bindings plus WORK (which asksite-sites itself never binds), so the seed
 *  reaches the same storage as `pnpm dev` whatever database id wrangler.jsonc holds. With remote, every
 *  binding is the production resource ("remote": true). */
export function toolsConfig(sites: { compatibility_date: string; d1_databases: object[]; r2_buckets: object[] }, remote: boolean): Record<string, unknown> {
  const mark = (binding: object): object => (remote ? { ...binding, remote: true } : binding);
  return {
    name: "asksite-dev-tools",
    compatibility_date: sites.compatibility_date,
    // A13: Node.js compatibility is on by default from 2026-08-04; Cloudflare turns it off with both.
    compatibility_flags: ["no_nodejs_compat", "no_nodejs_compat_v2"],
    d1_databases: sites.d1_databases.map(mark),
    r2_buckets: [...sites.r2_buckets, { binding: "WORK", bucket_name: "asksite-work" }].map(mark),
  };
}

type PhotoInput = NonNullable<SiteDocumentInput["facts"]["heroPhoto"]>;

/** The photo --hero-photo adds; its URL is replaced by the upload's. */
const SAMPLE_HERO: PhotoInput = { url: "https://media.invalid/sample.webp", alt: "Sample photo of the business at work", width: 1600, height: 900 };

/** Creates the owner, site, photos and an approved version for `slug`. Does nothing if the slug exists. */
export async function seedDemoSite(
  env: ToolsEnv & { ROOT_DOMAIN: string },
  input: { slug: string; document: SiteDocumentInput; now: number; ownerEmail: string; indexable: boolean },
): Promise<{ siteId: string; url: string; created: boolean }> {
  const { slug, document, now } = input;
  if (slugIssue(slug) !== null) throw new Error(`"${slug}" is not a usable slug`);
  const existing = await env.DB.prepare("SELECT id FROM sites WHERE slug = ?").bind(slug).first<{ id: string }>();
  if (existing !== null) return { siteId: existing.id, url: siteUrl(env.ROOT_DOMAIN, slug), created: false };

  const ownerId = newId();
  const siteId = newId();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO owners (id, email, created_at) VALUES (?, ?, ?)").bind(ownerId, input.ownerEmail, now),
    env.DB.prepare("INSERT INTO sites (id, owner_id, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(siteId, ownerId, slug, now, now),
  ]);

  const upload = async (photo: PhotoInput): Promise<PhotoInput> => {
    const uploadId = newId();
    await env.MEDIA.put(mediaKey(siteId, uploadId), DEMO_WEBP);
    await env.DB.prepare("INSERT INTO uploads (id, site_id, width, height, bytes, created_at) VALUES (?, ?, 1600, 900, ?, ?)")
      .bind(uploadId, siteId, DEMO_WEBP.byteLength, now)
      .run();
    return { ...photo, url: mediaUrl(env.ROOT_DOMAIN, siteId, uploadId), width: 1600, height: 900 };
  };
  const facts = document.facts;
  const heroPhoto = facts.heroPhoto === undefined ? undefined : await upload(facts.heroPhoto);
  const photos = await Promise.all((facts.photos ?? []).map(upload));
  const parsed = SiteDocument.parse({ ...document, facts: { ...facts, photos, ...(heroPhoto === undefined ? {} : { heroPhoto }) } });
  await env.DB.prepare("UPDATE sites SET facts_json = ? WHERE id = ?").bind(JSON.stringify(parsed.facts), siteId).run();

  const version = await createPendingVersion(env, { siteId, ownerId, slug, document: parsed, edits: EMPTY_EDITS, generationId: null, now });
  const row = await env.DB.prepare("SELECT html_sha256 FROM site_versions WHERE id = ?").bind(version.id).first<{ html_sha256: string }>();
  await approveVersion(env, { versionId: version.id, htmlSha256: row?.html_sha256 ?? "", reviewer: "dev-seed@localhost", note: "Seeded demo", indexable: input.indexable, now });
  return { siteId, url: siteUrl(env.ROOT_DOMAIN, slug), created: true };
}

async function main(): Promise<void> {
  const options = parseSeedOptions(process.argv.slice(2));
  const fixture = JSON.parse(readFileSync(join(REPO, "fixtures", `${options.fixture}.json`), "utf8")) as SiteDocumentInput;
  const document = options.heroPhoto ? { ...fixture, facts: { ...fixture.facts, heroPhoto: SAMPLE_HERO } } : fixture;

  const sites = JSON.parse(readFileSync(join(SITES_DIR, "wrangler.jsonc"), "utf8")) as Parameters<typeof toolsConfig>[0];
  writeFileSync(TOOLS_CONFIG, `${JSON.stringify(toolsConfig(sites, options.remote), null, 2)}\n`);
  if (!options.remote) {
    // Production migrations are applied by the deploy runbook (Task 19 Step 5), never from here.
    const migrate = spawnSync(join(REPO, "node_modules/.bin/wrangler"), ["d1", "migrations", "apply", "asksite", "--local", "--persist-to", options.persistTo, "--config", TOOLS_CONFIG], {
      cwd: REPO,
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (migrate.status !== 0) throw new Error("Applying local migrations failed");
  }

  // Loaded here, not at the top, so the unit test of the helpers above does not load wrangler.
  const { getPlatformProxy } = await import("wrangler");
  const proxy = await getPlatformProxy<ToolsEnv>({
    configPath: TOOLS_CONFIG,
    ...(options.remote ? {} : { persist: { path: join(REPO, options.persistTo, "v3") } }),
  });
  try {
    const ownerEmail = options.ownerEmail ?? `${options.slug}-owner@example.com`;
    const result = await seedDemoSite({ ...proxy.env, ROOT_DOMAIN: options.root }, { slug: options.slug, document, now: Date.now(), ownerEmail, indexable: options.indexable });
    console.log(JSON.stringify(result));
  } finally {
    await proxy.dispose();
  }
}

if (import.meta.main) await main();
