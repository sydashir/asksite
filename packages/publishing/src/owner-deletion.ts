import { canonicalJson, isId, liveKeyVersionId, mediaSitePrefix, REDACTED_REASON, workSitePrefix } from "@asksite/core";
import { PublishError } from "./errors.ts";
import { acquireLease, deletePrefix, LEASE_HELD, releaseLease } from "./shared.ts";
import { takeDownUnderLease } from "./site-state.ts";

/** Fences a write to a closing owner: nothing changes once the admin has enabled the owner again. */
const OWNER_CLOSING = "EXISTS (SELECT 1 FROM owners WHERE id = ? AND disabled_at IS NOT NULL)";

export interface OwnerDeletionCounts {
  /** owner.deletion_started rows for this owner, this run's included; more than 1 means earlier runs deleted part and these counts are THIS run's. */
  attempts: number;
  /** Every site of the owner this run or an earlier one knew, sorted. */
  siteIds: string[];
  rows: { sites: number; site_versions: number; generations: number; uploads: number; leads: number; invites: number; sessions: number; login_tokens: number; dev_outbox: number; owners: 1 };
  /** LIVE counts page objects only (R2's delete does not say whether a pointer existed). */
  objects: { work: number; live: number; media: number };
  auditRedacted: number;
}

export type DeleteOwnerResult =
  | { outcome: "deleted"; counts: OwnerDeletionCounts }
  | { outcome: "already_deleted" } // no owners row, and an owner.deleted row names this id
  | { outcome: "not_found" } // no owners row, and no owner.deleted row
  | { outcome: "not_disabled" } // owners.disabled_at IS NULL (also: enabled again mid-run)
  | { outcome: "email_mismatch" }; // confirmEmail.trim().toLowerCase() !== owners.email

interface OwnerRow {
  id: string;
  email: string;
  disabled_at: number | null;
}

/** The sites table's bulk children of one site, child-first (no ON DELETE anywhere; site_versions go before generations). */
const SITE_CHILDREN = ["leads", "uploads", "site_versions", "invites", "generations"] as const;
type SiteChild = (typeof SITE_CHILDREN)[number];

const childDeletes = (db: D1Database, siteId: string, token: string, ownerId: string): D1PreparedStatement[] =>
  SITE_CHILDREN.map((table) => db.prepare(`DELETE FROM ${table} WHERE site_id = ? AND ${LEASE_HELD} AND ${OWNER_CLOSING}`).bind(siteId, siteId, token, ownerId));

/**
 * The admin's Delete the account (owner data deletion on account closure). Only for an owner who is already disabled,
 * and only when `confirmEmail` is the owner's email. Every step is safe to run again: a failed run leaves the owner
 * disabled and the sites taken down, and calling again finishes it. In order:
 * 0) read and refuse (no writes): unknown or already deleted, not disabled, email mismatch;
 * 1) the lease of every site of the owner, all up front (a busy site refuses before anything changes);
 * 2) owner.deletion_started (the owner and site ids only), so a retry knows the sites even if their rows are gone;
 * 3a) per site: takeDownUnderLease with a media purge (every page stops at once, the pointer first), then WORK emptied;
 * 3b) one LIVE sweep by version id (pages left under an older slug by a failed approve), before any version row goes;
 * 3c) per site: MEDIA again and one batch of the bulk rows (leads, uploads, versions, invites, generations);
 * 4a) the two free-text audit reasons redacted (REDACTED_REASON), prefixes of sites with no row emptied;
 * 4b) ONE batch: the emptied sites rows, the owner-level rows (generations, sessions, sign-in links, every invite for the
 *     owner or the owner's email, dev outbox), the owners row and the owner.deleted row (counts only), all or nothing.
 * Every D1 write carries the lease of its site and/or OWNER_CLOSING. Throws site_busy with retryAfter (a site is held;
 * nothing was deleted) or site_busy lease_lost (the run outlived ADMIN_LEASE_MS; call again); any D1 or R2 error as it is.
 */
export async function deleteOwner(
  env: { DB: D1Database; WORK: R2Bucket; LIVE: R2Bucket; MEDIA: R2Bucket },
  input: { ownerId: string; confirmEmail: string; reviewer: string; now: number },
): Promise<DeleteOwnerResult> {
  const { ownerId, now } = input;
  const db = env.DB;
  const actor = `admin:${input.reviewer}`;

  // Phase 0: read and refuse.
  const owner = await readOwner(db, ownerId);
  if (owner === null) return gone(db, ownerId);
  if (owner.disabled_at === null) return { outcome: "not_disabled" };
  if (input.confirmEmail.trim().toLowerCase() !== owner.email) return { outcome: "email_mismatch" };
  const presentIds = (await db.prepare("SELECT id FROM sites WHERE owner_id = ? ORDER BY id").bind(ownerId).all<{ id: string }>()).results.map((row) => row.id);
  const started = await db
    .prepare("SELECT detail_json FROM audit_log WHERE action = 'owner.deletion_started' AND site_id IS NULL AND json_extract(detail_json, '$.ownerId') = ?")
    .bind(ownerId)
    .all<{ detail_json: string }>();
  const allSiteIds = [...new Set([...presentIds, ...started.results.flatMap((row) => earlierSiteIds(row.detail_json))])].sort();
  const attempts = started.results.length + 1;

  // Phase 1: every lease, in id order, before anything changes.
  const tokens = new Map<string, string>();
  const releaseAll = async () => {
    for (const [siteId, token] of tokens) await releaseLease(db, siteId, token);
  };
  try {
    for (const id of presentIds) {
      try {
        tokens.set(id, await acquireLease(db, id, now, "site_not_found"));
      } catch (error) {
        if (!(error instanceof PublishError) || error.code !== "site_not_found") throw error;
        // Another run of this owner committed meanwhile: gone, or still here and busy.
        await releaseAll();
        tokens.clear();
        if ((await readOwner(db, ownerId)) === null) return gone(db, ownerId);
        throw new PublishError("site_busy", { retryAfter: 1 });
      }
    }
    return await deleteUnderLeases(env, { ownerId, email: owner.email, actor, reviewer: input.reviewer, now, presentIds, allSiteIds, attempts, tokens });
  } finally {
    await releaseAll();
  }
}

async function deleteUnderLeases(
  env: { DB: D1Database; WORK: R2Bucket; LIVE: R2Bucket; MEDIA: R2Bucket },
  run: { ownerId: string; email: string; actor: string; reviewer: string; now: number; presentIds: string[]; allSiteIds: string[]; attempts: number; tokens: Map<string, string> },
): Promise<DeleteOwnerResult> {
  const { ownerId, email, actor, reviewer, now, presentIds, allSiteIds, attempts, tokens } = run;
  const db = env.DB;
  const tokenOf = (siteId: string): string => tokens.get(siteId) ?? "";

  // Phase 2: the intent row (fenced: an owner enabled again meanwhile is not closed).
  const intent = await db
    .prepare(`INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?, ?, 'owner.deletion_started', NULL, ? WHERE ${OWNER_CLOSING}`)
    .bind(now, actor, canonicalJson({ ownerId, siteIds: allSiteIds }), ownerId)
    .run();
  if (intent.meta.changes !== 1) return { outcome: "not_disabled" };

  const objects = { work: 0, live: 0, media: 0 };
  const removed: Record<SiteChild, number> = { leads: 0, uploads: 0, site_versions: 0, invites: 0, generations: 0 };

  // Phase 3a: stop serving and empty WORK, per site.
  for (const siteId of presentIds) {
    const taken = await takeDownUnderLease(env, { siteId, reviewer, reason: REDACTED_REASON, purgeMedia: true, now, token: tokenOf(siteId) });
    objects.live += taken.live;
    objects.media += taken.media;
    objects.work += await deletePrefix(env.WORK, workSitePrefix(siteId));
  }

  // Phase 3b: the LIVE sweep by version id, once, before any site_versions row goes.
  if (presentIds.length > 0) {
    const versions = await db.prepare("SELECT id FROM site_versions WHERE site_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(presentIds)).all<{ id: string }>();
    const versionIds = new Set(versions.results.map((row) => row.id));
    const leasesHeld = async (): Promise<boolean> => {
      const rows = (await db.prepare("SELECT id, admin_lock FROM sites WHERE owner_id = ?").bind(ownerId).all<{ id: string; admin_lock: string | null }>()).results;
      return presentIds.every((id) => rows.some((row) => row.id === id && row.admin_lock === tokenOf(id)));
    };
    const keep = (key: string): boolean => {
      const version = liveKeyVersionId(key);
      return version === null || !versionIds.has(version);
    };
    objects.live += await deletePrefix(env.LIVE, "", keep, leasesHeld);
    if (!(await leasesHeld())) throw new PublishError("site_busy", { reason: "lease_lost" });
  }

  // Phase 3c: per site, MEDIA again (an upload in flight at disable time) and the bulk rows.
  for (const siteId of presentIds) {
    objects.media += await deletePrefix(env.MEDIA, mediaSitePrefix(siteId));
    const results = await db.batch(childDeletes(db, siteId, tokenOf(siteId), ownerId));
    SITE_CHILDREN.forEach((table, i) => {
      removed[table] += results[i]?.meta.changes ?? 0;
    });
  }
  if ((await readOwner(db, ownerId))?.disabled_at === null) return { outcome: "not_disabled" }; // enabled again mid-run

  // Phase 4a: leftover prefixes of sites with no row, and the audit redaction.
  for (const siteId of allSiteIds) {
    if (presentIds.includes(siteId)) continue;
    objects.work += await deletePrefix(env.WORK, workSitePrefix(siteId));
    objects.media += await deletePrefix(env.MEDIA, mediaSitePrefix(siteId));
  }
  const redacted = await db
    .prepare(
      `UPDATE audit_log SET detail_json = json_replace(detail_json, '$.reason', ?1)
       WHERE ((action = 'site.taken_down' AND site_id IN (SELECT value FROM json_each(?2)))
           OR (action = 'owner.disabled' AND site_id IS NULL AND json_extract(detail_json, '$.ownerId') = ?3))
         AND json_type(detail_json, '$.reason') = 'text'
         AND json_extract(detail_json, '$.reason') IS NOT ?1`,
    )
    .bind(REDACTED_REASON, JSON.stringify(allSiteIds), ownerId)
    .run();

  // Phase 4b: the final batch. The counts first (the batch's own changes are unknown when its audit row is bound).
  const left = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM leads WHERE site_id IN (SELECT value FROM json_each(?1))) AS leads,
              (SELECT COUNT(*) FROM uploads WHERE site_id IN (SELECT value FROM json_each(?1))) AS uploads,
              (SELECT COUNT(*) FROM site_versions WHERE site_id IN (SELECT value FROM json_each(?1))) AS site_versions,
              (SELECT COUNT(*) FROM invites WHERE site_id IN (SELECT value FROM json_each(?1)) OR owner_id = ?2 OR email = ?3) AS invites,
              (SELECT COUNT(*) FROM generations WHERE site_id IN (SELECT value FROM json_each(?1)) OR owner_id = ?2) AS generations,
              (SELECT COUNT(*) FROM sites WHERE owner_id = ?2) AS sites,
              (SELECT COUNT(*) FROM sessions WHERE owner_id = ?2) AS sessions,
              (SELECT COUNT(*) FROM login_tokens WHERE owner_id = ?2) AS login_tokens,
              (SELECT COUNT(*) FROM dev_outbox WHERE to_addr = ?3) AS dev_outbox`,
    )
    .bind(JSON.stringify(presentIds), ownerId, email)
    .first<Record<"leads" | "uploads" | "site_versions" | "invites" | "generations" | "sites" | "sessions" | "login_tokens" | "dev_outbox", number>>();
  if (left === null) throw new Error("owner_delete_count_missing");
  const counts: OwnerDeletionCounts = {
    attempts,
    siteIds: allSiteIds,
    rows: {
      sites: left.sites,
      site_versions: removed.site_versions + left.site_versions,
      generations: removed.generations + left.generations,
      uploads: removed.uploads + left.uploads,
      leads: removed.leads + left.leads,
      invites: removed.invites + left.invites,
      sessions: left.sessions,
      login_tokens: left.login_tokens,
      dev_outbox: left.dev_outbox,
      owners: 1,
    },
    objects,
    auditRedacted: redacted.meta.changes,
  };

  const statements: D1PreparedStatement[] = [];
  for (const siteId of presentIds) {
    statements.push(...childDeletes(db, siteId, tokenOf(siteId), ownerId));
    statements.push(db.prepare(`DELETE FROM sites WHERE id = ? AND owner_id = ? AND admin_lock = ? AND ${OWNER_CLOSING}`).bind(siteId, ownerId, tokenOf(siteId), ownerId));
  }
  statements.push(
    db.prepare(`DELETE FROM generations WHERE owner_id = ? AND ${OWNER_CLOSING}`).bind(ownerId, ownerId),
    db.prepare(`DELETE FROM sessions WHERE owner_id = ? AND ${OWNER_CLOSING}`).bind(ownerId, ownerId),
    db.prepare(`DELETE FROM login_tokens WHERE owner_id = ? AND ${OWNER_CLOSING}`).bind(ownerId, ownerId),
    // The owner's open and revoked invites too (by email): an open one would make a new owner of the same address on accept.
    db.prepare(`DELETE FROM invites WHERE (owner_id = ? OR email = ?) AND ${OWNER_CLOSING}`).bind(ownerId, email, ownerId),
    db.prepare(`DELETE FROM dev_outbox WHERE to_addr = ? AND ${OWNER_CLOSING}`).bind(email, ownerId),
    db.prepare("DELETE FROM owners WHERE id = ? AND disabled_at IS NOT NULL").bind(ownerId),
    // As auditIfChanged: the row exists exactly when the statement just before it deleted the owner.
    db
      .prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?, ?, 'owner.deleted', NULL, ? WHERE changes() = 1")
      .bind(now, actor, canonicalJson({ ownerId, ...counts })),
  );
  const ownerDeleted = statements.length - 2;
  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    // D1 can commit a batch and still throw (versions.ts): the owner gone and its owner.deleted row there means it did.
    let after: OwnerRow | null;
    try {
      after = await readOwner(db, ownerId);
    } catch {
      throw error;
    }
    if (after === null && (await deletedRowExists(db, ownerId))) return { outcome: "deleted", counts };
    if (after !== null && !(await sitesStillOurs(db, ownerId, presentIds, tokens).catch(() => true))) throw new PublishError("site_busy", { reason: "lease_lost" });
    throw error;
  }
  if (results[ownerDeleted]?.meta.changes === 1) return { outcome: "deleted", counts };
  const after = await readOwner(db, ownerId);
  if (after === null) return { outcome: "already_deleted" };
  if (after.disabled_at === null) return { outcome: "not_disabled" };
  throw new Error("owner_delete_incomplete"); // not reachable by design: the batch rolls back or deletes the owner
}

const readOwner = (db: D1Database, ownerId: string): Promise<OwnerRow | null> =>
  db.prepare("SELECT id, email, disabled_at FROM owners WHERE id = ?").bind(ownerId).first<OwnerRow>();

/** The owner row is gone: already_deleted when an owner.deleted row names it, else it never existed. */
async function gone(db: D1Database, ownerId: string): Promise<DeleteOwnerResult> {
  return (await deletedRowExists(db, ownerId)) ? { outcome: "already_deleted" } : { outcome: "not_found" };
}

async function deletedRowExists(db: D1Database, ownerId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS found FROM audit_log WHERE action = 'owner.deleted' AND site_id IS NULL AND json_extract(detail_json, '$.ownerId') = ? LIMIT 1")
    .bind(ownerId)
    .first<{ found: number }>();
  return row !== null;
}

async function sitesStillOurs(db: D1Database, ownerId: string, presentIds: string[], tokens: Map<string, string>): Promise<boolean> {
  const rows = (await db.prepare("SELECT id, admin_lock FROM sites WHERE owner_id = ?").bind(ownerId).all<{ id: string; admin_lock: string | null }>()).results;
  return presentIds.every((id) => rows.some((row) => row.id === id && row.admin_lock === tokens.get(id)));
}

/** The site ids an earlier owner.deletion_started row named (only real ids: the row is ours, but a prefix is never built from a damaged one). */
function earlierSiteIds(detailJson: string): string[] {
  try {
    const ids = (JSON.parse(detailJson) as { siteIds?: unknown }).siteIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && isId(id)) : [];
  } catch {
    return [];
  }
}
