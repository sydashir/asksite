import { canonicalJson, livePageKey, liveKeyVersionId, mediaKey, mediaSitePrefix, newId, workSitePrefix } from "@asksite/core";
import { approveVersion, createPendingVersion, rejectVersion, restore, takeDown, withdrawPending } from "../../src/index.ts";
import { doc, EDITS, type PublishEnv } from "./harness.ts";

/** The admin free text the closure must redact, and the owner's business name that must not stay anywhere. */
export const TAKEDOWN_REASON = "Phishing report naming Joe's Plumbing";
export const REPEAT_REASON = "Second note about Joe's Plumbing";
export const DISABLE_REASON = "Closure request from Joe's Plumbing";
export const ADMIN = "admin@example.com";
export const SEED_NOW = 1_000_000;

let counter = 0;

export interface SeededSite {
  siteId: string;
  slug: string;
  versionIds: string[];
  uploadIds: string[];
  leadIds: string[];
  generationIds: string[];
}

/** One owner of the closure shape, with the exact counts of what the seed made (hand-counted below, not queried back). */
export interface ClosingOwner {
  label: string;
  ownerId: string;
  email: string;
  /** Site A: live (v1 approved), v2 pending, v0 rejected; taken down once and restored. */
  a: SeededSite;
  /** Site B: never live (vB withdrawn); its first slug was renamed, and an approve's orphan copy sits under the old slug. */
  b: SeededSite & { oldSlug: string; orphanKey: string; orphanVersionId: string };
  /** Every site of the owner, sorted (extras of the control are added here too). */
  siteIds: string[];
  /** The owner.deleted counts this seed must give on a first run. */
  expected: { sites: number; site_versions: number; generations: number; uploads: number; leads: number; invites: number; sessions: number; login_tokens: number; dev_outbox: number; work: number; live: number; media: number };
}

const sha = (n: number) => n.toString(16).padStart(64, "0");

async function addGenerations(db: D1Database, ownerId: string, siteId: string): Promise<string[]> {
  const ids = [newId(), newId()];
  await db.batch([
    db.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, output_json, created_at) VALUES (?, ?, ?, 'first', 'succeeded', ?, ?, 1)")
      .bind(ids[0], siteId, ownerId, `{"businessName":"Joe's Plumbing"}`, `{"headline":"Joe's Plumbing"}`),
    db.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at) VALUES (?, ?, ?, 'regenerate', 'failed', ?, 2)")
      .bind(ids[1], siteId, ownerId, `{"businessName":"Joe's Plumbing"}`),
  ]);
  return ids;
}

/** 3 uploads (the 3rd soft-deleted) with their MEDIA objects, and 3 leads (the 3rd spam). */
async function addMediaAndLeads(env: PublishEnv, siteId: string): Promise<{ uploadIds: string[]; leadIds: string[] }> {
  const uploadIds = [newId(), newId(), newId()];
  const leadIds = [newId(), newId(), newId()];
  await env.DB.batch([
    ...uploadIds.map((id, i) =>
      env.DB.prepare("INSERT INTO uploads (id, site_id, width, height, bytes, created_at, deleted_at) VALUES (?, ?, 100, 100, 10, 1, ?)").bind(id, siteId, i === 2 ? 5 : null),
    ),
    ...leadIds.map((id, i) =>
      env.DB.prepare("INSERT INTO leads (id, site_id, created_at, name, phone, email, service, message, spam, email_status, ip_hash) VALUES (?, ?, 1, ?, '+15125550100', ?, 'Drain', ?, ?, 'sent', ?)")
        .bind(id, siteId, `Visitor ${i}`, `visitor${i}@example.net`, `Please call about a leak ${i}`, i === 2 ? 1 : 0, sha(i)),
    ),
  ]);
  await Promise.all(uploadIds.map((id) => env.MEDIA.put(mediaKey(siteId, id), `photo ${id}`, { customMetadata: { siteId, uploadId: id } })));
  return { uploadIds, leadIds };
}

/** An approved site (a real pending version, a real approve) for a control owner. */
export async function addApprovedSite(env: PublishEnv, ownerId: string, slug: string): Promise<{ siteId: string; slug: string; versionId: string }> {
  const siteId = newId();
  await env.DB.prepare("INSERT INTO sites (id, owner_id, slug, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").bind(siteId, ownerId, slug).run();
  const version = await createPendingVersion(env, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 10 });
  await approve(env, version.id);
  return { siteId, slug, versionId: version.id };
}

async function approve(env: PublishEnv, versionId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT html_sha256 FROM site_versions WHERE id = ?").bind(versionId).first<{ html_sha256: string }>();
  await approveVersion(env, { versionId, htmlSha256: String(row?.html_sha256), reviewer: ADMIN, note: null, indexable: true, now: 11 });
}

/**
 * An owner of the closure shape, disabled and ready to delete: see the build brief, test plan D (seed). Built with the
 * real createPendingVersion, approveVersion, takeDown, restore and withdrawPending.
 */
export async function seedClosingOwner(env: PublishEnv, label: string): Promise<ClosingOwner> {
  counter += 1;
  const n = counter;
  const db = env.DB;
  const ownerId = newId();
  const email = `${label}-${ownerId}@example.com`;
  await db.prepare("INSERT INTO owners (id, email, created_at) VALUES (?, ?, 1)").bind(ownerId, email).run();

  // Site A: v0 rejected, v1 approved (live), takedown + restore, v2 pending.
  const aId = newId();
  const aSlug = `${label}-a-${n}-${aId.slice(0, 8)}`;
  await db.prepare("INSERT INTO sites (id, owner_id, slug, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").bind(aId, ownerId, aSlug).run();
  const aGenerations = await addGenerations(db, ownerId, aId);
  const create = (siteId: string, slug: string, generationId: string | null) =>
    createPendingVersion(env, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId, now: 10 }).then((v) => v.id);
  const v0 = await create(aId, aSlug, null);
  await rejectVersion(env, { versionId: v0, reviewer: ADMIN, note: "Not yet", now: 11 });
  const v1 = await create(aId, aSlug, aGenerations[0] ?? null); // a version that names a generation: proves the delete order
  await approve(env, v1);
  await takeDown(env, { siteId: aId, reviewer: ADMIN, reason: TAKEDOWN_REASON, purgeMedia: false, now: 20 });
  await restore(env, { siteId: aId, reviewer: ADMIN, expectedTakenDownAt: 20, now: 21 });
  const v2 = await create(aId, aSlug, null);
  // The admin route's repeat row: {"reason", "purgeMedia", "repeat"}.
  await db.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (22, ?, 'site.taken_down', ?, ?)").bind(`admin:${ADMIN}`, aId, JSON.stringify({ reason: REPEAT_REASON, purgeMedia: true, repeat: true })).run();
  // Rows without a reason (an older writer, or a takedown with none): redaction must leave them as they are.
  await db.batch([
    db.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (22, ?, 'site.taken_down', ?, ?)").bind(`admin:${ADMIN}`, aId, JSON.stringify({ purgeMedia: false })),
    db.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (22, ?, 'owner.disabled', NULL, ?)").bind(`admin:${ADMIN}`, JSON.stringify({ ownerId })),
  ]);
  const aMedia = await addMediaAndLeads(env, aId);

  // Site B: never live. vB pending then withdrawn; an approve's orphan copy under the first slug; the slug then renamed.
  const bId = newId();
  const bOld = `${label}-old-${n}-${bId.slice(0, 8)}`;
  const bNew = `${label}-new-${n}-${bId.slice(0, 8)}`;
  await db.prepare("INSERT INTO sites (id, owner_id, slug, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").bind(bId, ownerId, bOld).run();
  const bGenerations = await addGenerations(db, ownerId, bId);
  const vB = await create(bId, bOld, null);
  await withdrawPending(env, { siteId: bId, ownerId, now: 12 });
  const orphanKey = livePageKey(bOld, vB, "home");
  await env.LIVE.put(orphanKey, "<p>orphan of a failed approve</p>", { customMetadata: { siteId: bId, versionId: vB, page: "home", sha256: sha(7) } });
  await db.prepare("UPDATE sites SET slug = ? WHERE id = ?").bind(bNew, bId).run();
  const bMedia = await addMediaAndLeads(env, bId);

  // The owner level.
  await db.batch([
    ...[0, 1].map((i) => db.prepare("INSERT INTO sessions (id_hash, owner_id, created_at, expires_at, last_seen_at) VALUES (?, ?, 1, 9000000000000, 1)").bind(sha(100 + i) + n, ownerId)),
    ...[0, 1].map((i) => db.prepare("INSERT INTO login_tokens (token_hash, owner_id, created_at, expires_at) VALUES (?, ?, 1, 9000000000000)").bind(sha(200 + i) + n, ownerId)),
    db.prepare("INSERT INTO invites (id, token_hash, email, created_by, created_at, expires_at, used_at, owner_id, site_id) VALUES (?, ?, ?, ?, 1, 9000000000000, 2, ?, ?)").bind(newId(), newId(), email, ADMIN, ownerId, aId),
    db.prepare("INSERT INTO invites (id, token_hash, email, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, 1, 9000000000000)").bind(newId(), newId(), email, ADMIN), // OPEN: no owner, no site
    db.prepare("INSERT INTO invites (id, token_hash, email, created_by, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, 1, 9000000000000, 3)").bind(newId(), newId(), email, ADMIN),
    db.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (23, ?, 'auth.login', NULL, NULL)").bind(`owner:${ownerId}`),
    db.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (24, ?, 'owner.disabled', NULL, ?)").bind(`admin:${ADMIN}`, JSON.stringify({ ownerId, reason: DISABLE_REASON })),
    db.prepare("INSERT INTO dev_outbox (at, to_addr, subject, text, tag) VALUES (1, ?, 'Your sign-in link', 'https://app.example/login?t=abc', 'login')").bind(email),
    db.prepare("UPDATE owners SET disabled_at = 24, disabled_reason = 'Closure request from Joe' WHERE id = ?").bind(ownerId),
  ]);

  return {
    label,
    ownerId,
    email,
    a: { siteId: aId, slug: aSlug, versionIds: [v0, v1, v2], ...aMedia, generationIds: aGenerations },
    b: { siteId: bId, slug: bNew, oldSlug: bOld, orphanKey, orphanVersionId: vB, versionIds: [vB], ...bMedia, generationIds: bGenerations },
    siteIds: [aId, bId].sort(),
    // WORK: 4 versions x 5 pages. LIVE: v1's 5 pages (takedown) + the orphan (sweep). MEDIA: 3 + 3 (takedown purge).
    expected: { sites: 2, site_versions: 4, generations: 4, uploads: 6, leads: 6, invites: 3, sessions: 2, login_tokens: 2, dev_outbox: 1, work: 20, live: 6, media: 6 },
  };
}

/** The control's extras: a site whose slug is the target A's slug + "s" (a prefix neighbour), and one that CLAIMS the target's freed old slug. */
export async function addControlSites(env: PublishEnv, control: ClosingOwner, target: ClosingOwner): Promise<{ neighbour: string; claimant: string }> {
  const neighbour = await addApprovedSite(env, control.ownerId, `${target.a.slug}s`);
  const claimant = await addApprovedSite(env, control.ownerId, target.b.oldSlug);
  // The claimant's approve removed every other version's pages under the slug, the orphan too (removeOtherVersions). Plant
  // it again, as a state that approve's cleanup can leave (live_cleanup_skipped): the sweep must find it next to the claimant's keys.
  await env.LIVE.put(target.b.orphanKey, "<p>orphan of a failed approve</p>", { customMetadata: { siteId: target.b.siteId, versionId: target.b.orphanVersionId, page: "home", sha256: sha(7) } });
  control.siteIds = [...control.siteIds, neighbour.siteId, claimant.siteId].sort();
  return { neighbour: neighbour.slug, claimant: claimant.slug };
}

const TABLES = ["owners", "sites", "invites", "login_tokens", "sessions", "uploads", "generations", "site_versions", "leads", "settings", "audit_log", "dev_outbox"] as const;
const BUCKETS = ["WORK", "LIVE", "MEDIA"] as const;

interface Listed {
  key: string;
  size: number;
  etag: string;
  customMetadata: Record<string, string> | undefined;
  contentType: string | undefined;
}

/** Every object of a bucket with its metadata (include is asked for, as R2 returns less without it), no bodies. */
export async function listMeta(bucket: R2Bucket, prefix = ""): Promise<Listed[]> {
  const out: Listed[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, include: ["customMetadata", "httpMetadata"], ...(cursor === undefined ? {} : { cursor }) });
    for (const o of page.objects) out.push({ key: o.key, size: o.size, etag: o.etag, customMetadata: o.customMetadata, contentType: o.httpMetadata?.contentType });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return out;
}

/** The same objects with their text, read 50 at a time. */
export async function withText(bucket: R2Bucket, items: Listed[]): Promise<Array<Listed & { text: string }>> {
  const out: Array<Listed & { text: string }> = [];
  for (let i = 0; i < items.length; i += 50) {
    out.push(...(await Promise.all(items.slice(i, i + 50).map(async (item) => ({ ...item, text: (await (await bucket.get(item.key))?.text()) ?? "" })))));
  }
  return out;
}

/** Every object of a bucket under a prefix with its metadata and its text. */
export const listBucket = async (bucket: R2Bucket, prefix = ""): Promise<Array<Listed & { text: string }>> => withText(bucket, await listMeta(bucket, prefix));

/** Every row of all 12 tables (ordered by their keys) and every object of the 3 buckets. */
export async function dumpAll(env: PublishEnv): Promise<unknown> {
  const rows: Record<string, unknown[]> = {};
  for (const table of TABLES) rows[table] = (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()).results.map((r) => canonicalJson(r));
  const objects: Record<string, unknown> = {};
  for (const name of BUCKETS) objects[name] = await listBucket(env[name]);
  return { rows, objects };
}

/** Everything that belongs to one owner: its rows (by owner_id, site_id, email, audit links) and its objects (by prefix, pointer, version id, metadata). */
export async function dumpScope(env: PublishEnv, o: ClosingOwner): Promise<unknown> {
  const db = env.DB;
  const ids = JSON.stringify(o.siteIds);
  const q = async (sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).all()).results.map((r) => canonicalJson(r));
  const versionIds = (await db.prepare("SELECT id FROM site_versions WHERE site_id IN (SELECT value FROM json_each(?))").bind(ids).all<{ id: string }>()).results.map((r) => r.id);
  const rows = {
    owners: await q("SELECT * FROM owners WHERE id = ? OR email = ? ORDER BY id", o.ownerId, o.email),
    sites: await q("SELECT * FROM sites WHERE owner_id = ? OR id IN (SELECT value FROM json_each(?)) ORDER BY id", o.ownerId, ids),
    leads: await q("SELECT * FROM leads WHERE site_id IN (SELECT value FROM json_each(?)) ORDER BY id", ids),
    uploads: await q("SELECT * FROM uploads WHERE site_id IN (SELECT value FROM json_each(?)) ORDER BY id", ids),
    site_versions: await q("SELECT * FROM site_versions WHERE site_id IN (SELECT value FROM json_each(?)) ORDER BY id", ids),
    generations: await q("SELECT * FROM generations WHERE owner_id = ? OR site_id IN (SELECT value FROM json_each(?)) ORDER BY id", o.ownerId, ids),
    sessions: await q("SELECT * FROM sessions WHERE owner_id = ? ORDER BY id_hash", o.ownerId),
    login_tokens: await q("SELECT * FROM login_tokens WHERE owner_id = ? ORDER BY token_hash", o.ownerId),
    invites: await q("SELECT * FROM invites WHERE owner_id = ? OR email = ? OR site_id IN (SELECT value FROM json_each(?)) ORDER BY id", o.ownerId, o.email, ids),
    dev_outbox: await q("SELECT * FROM dev_outbox WHERE to_addr = ? ORDER BY id", o.email),
    audit_log: await q(
      "SELECT * FROM audit_log WHERE site_id IN (SELECT value FROM json_each(?)) OR actor = ? OR json_extract(detail_json, '$.ownerId') = ? ORDER BY id",
      ids,
      `owner:${o.ownerId}`,
      o.ownerId,
    ),
  };
  const slugs = (await db.prepare("SELECT slug FROM sites WHERE id IN (SELECT value FROM json_each(?)) AND slug IS NOT NULL").bind(ids).all<{ slug: string }>()).results.map((r) => r.slug);
  const work = (await Promise.all(o.siteIds.map((id) => listBucket(env.WORK, workSitePrefix(id))))).flat();
  const media = (await Promise.all(o.siteIds.map((id) => listBucket(env.MEDIA, mediaSitePrefix(id))))).flat();
  const live = await withText(env.LIVE, (await listMeta(env.LIVE)).filter((obj) => {
    const version = liveKeyVersionId(obj.key);
    const owned = obj.customMetadata?.["siteId"] === undefined || o.siteIds.includes(obj.customMetadata["siteId"]);
    return (
      // A slug of this owner, but only its own objects: another owner's orphan under a freed slug is not in this scope.
      (owned && slugs.some((slug) => obj.key === slug || obj.key.startsWith(`${slug}/`))) ||
      (version !== null && versionIds.includes(version)) ||
      (obj.customMetadata?.["siteId"] !== undefined && o.siteIds.includes(obj.customMetadata["siteId"]))
    );
  }));
  return { rows, work, media, live };
}
