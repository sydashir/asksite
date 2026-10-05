import type { Mailer } from "@asksite/app-common";
import { livePageKey, livePointerKey, liveSitePrefix, newId, pagesDigest, sha256Hex, siteUrl, versionPageKey, VersionPages, type SiteVersionRow } from "@asksite/core";
import { formatPhone } from "@asksite/renderer";
import { acquireLease, assertLease, PublishError as RealPublishError, releaseLease, TAKEDOWN_REVIEW_NOTE } from "@asksite/publishing";
import type { SiteDocument } from "@asksite/site-schema";
import { fakeCreateMailer, toGenerationView } from "../../../app/test/support/fakes.ts";
import { RESTORE_SITE_SQL } from "../../../app/test/support/plan2b-statements.ts";
import type { AdminDeps, AdminGenerationDeps, AdminPublishingDeps, MailerEnv, PublishErrorCode } from "../../src/worker/deps.ts";

// Test stand-ins for the Plan 2 functions the admin calls (§7.2), following the documented steps (the A16 pointer
// model: every page copied to its own LIVE key, one pointer per site switches them all) closely enough for this
// Worker's tests, with the real core helpers for every key and hash so they cannot drift from Plan 2. The integration
// task swaps in @asksite/publishing.

/** The admin's own, so it can carry every code the admin knows (the app's fake has no `site_busy`): same shape as Plan 2's PublishError. */
class FakePublishError extends Error {
  readonly code: PublishErrorCode;
  readonly detail: unknown;

  constructor(code: PublishErrorCode, detail?: unknown) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

/**
 * A16-4c: one admin action per site at a time. The REAL lease functions (@asksite/publishing's acquireLease and releaseLease,
 * on the sites row's admin_lock) so a test can hold a site by writing admin_lock / admin_lock_until, as another action would;
 * the real PublishError is turned into this file's fake, which the admin routes recognise. Used by approve, restore and
 * copyLivePagesAgain; `run` gets the lease's token.
 */
async function underLease<T>(db: D1Database, siteId: string, now: number, run: (token: string) => Promise<T>, missing: "site_not_found" | "version_not_pending" = "site_not_found"): Promise<T> {
  let token: string;
  try {
    token = await acquireLease(db, siteId, now, missing);
  } catch (err) {
    if (err instanceof RealPublishError) throw new FakePublishError(err.code, err.detail);
    throw err;
  }
  try {
    return await run(token);
  } finally {
    await releaseLease(db, siteId, token);
  }
}

/** The real assertLease, as the fake's own error: a write to R2 is preceded by it (the real approve does so before its pointer write). */
async function holdsLease(db: D1Database, siteId: string, token: string): Promise<void> {
  try {
    await assertLease(db, siteId, token);
  } catch (err) {
    if (err instanceof RealPublishError) throw new FakePublishError(err.code, err.detail);
    throw err;
  }
}

const audit = (db: D1Database, at: number, reviewer: string, action: string, siteId: string, detail: Record<string, unknown> = {}) =>
  db.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (?, ?, ?, ?, ?)").bind(at, `admin:${reviewer}`, action, siteId, JSON.stringify(detail));

/** Every stored page of the version, proved against its row as Plan 2's verifiedPages does (the digest, then each page's bytes). */
async function verifiedPages(work: R2Bucket, row: { site_id: string; id: string; pages_json: string; html_sha256: string }): Promise<Array<{ page: VersionPages[number]["page"]; sha256: string; bytes: string }>> {
  const listed = VersionPages.safeParse(JSON.parse(row.pages_json || "null"));
  if (!listed.success || (await pagesDigest(listed.data)) !== row.html_sha256) throw new FakePublishError("integrity");
  return Promise.all(
    listed.data.map(async ({ page, sha256 }) => {
      const object = await work.get(versionPageKey(row.site_id, row.id, page));
      const bytes = object === null ? null : await object.text();
      if (bytes === null || (await sha256Hex(bytes)) !== sha256) throw new FakePublishError("integrity");
      return { page, sha256, bytes };
    }),
  );
}

async function copyPages(live: R2Bucket, slug: string, ids: { siteId: string; versionId: string }, pages: Awaited<ReturnType<typeof verifiedPages>>): Promise<void> {
  await Promise.all(
    pages.map((p) =>
      live.put(livePageKey(slug, ids.versionId, p.page), p.bytes, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        customMetadata: { siteId: ids.siteId, versionId: ids.versionId, page: p.page, sha256: p.sha256 },
      }),
    ),
  );
}

/**
 * The one write that switches the site to a version: an empty object whose metadata names it and the business, plus
 * `writer`, the writing call's own random id (never the lease token), as Plan 2's writeLivePointer (shared.ts:170-177).
 */
async function writePointer(live: R2Bucket, slug: string, ids: { siteId: string; versionId: string }, documentJson: string, writeId: string): Promise<void> {
  const { facts } = JSON.parse(documentJson) as SiteDocument;
  await live.put(livePointerKey(slug), "", { customMetadata: { ...ids, businessName: facts.businessName, phoneText: formatPhone(facts.phone), phoneTel: facts.phone, writer: writeId } });
}

/** What a take-back's one D1 re-read returns (shared.ts:180-184 TakeBackRow). */
interface TakeBackRow {
  taken_down_at: number | null;
  admin_lock: string | null;
}

/** Plan 2's holdsDownSite (shared.ts:193-195, internal to @asksite/publishing): the site is down AND this action's token still holds it. */
function holdsDownSite(row: TakeBackRow | null, token: string): boolean {
  return row !== null && row.taken_down_at !== null && row.admin_lock === token;
}

/**
 * Plan 2's takeBackPointer (shared.ts:220-241, internal to @asksite/publishing): deletes the pointer only when its `writer`
 * is this call's `writeId`, or whoever wrote it when `anyPointer` (holdsDownSite of the re-read row); a missing pointer needs no
 * delete, a HEAD that throws deletes, and a failed delete is swallowed (the real one logs ids only; the fakes log nothing).
 */
async function takeBackPointer(live: R2Bucket, slug: string, writeId: string, anyPointer: boolean): Promise<void> {
  try {
    let ours = true; // a HEAD that throws: delete
    try {
      const pointer = await live.head(livePointerKey(slug));
      if (pointer === null) return;
      ours = anyPointer || pointer.customMetadata?.["writer"] === writeId;
    } catch {
      // unknown whose it is
    }
    if (ours) await live.delete(livePointerKey(slug));
  } catch {
    // a failed take-back delete: the real one logs it
  }
}

/** Deletes every object under the prefix, a listing page at a time, one array delete per page (as Plan 2's deletePrefix). */
async function deletePrefix(bucket: R2Bucket, prefix: string, keep: (key: string) => boolean = () => false): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await bucket.list(cursor === undefined ? { prefix } : { prefix, cursor });
    const doomed = page.objects.map((o) => o.key).filter((key) => !keep(key));
    if (doomed.length > 0) await bucket.delete(doomed);
    deleted += doomed.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return deleted;
}

/** Best effort, as Plan 2's removeOtherVersions: the other versions' LIVE pages go; a failure leaves harmless orphans. */
async function removeOtherVersions(live: R2Bucket, slug: string, versionId: string): Promise<void> {
  const kept = `${liveSitePrefix(slug)}${versionId}/`;
  try {
    await deletePrefix(live, liveSitePrefix(slug), (key) => key.startsWith(kept));
  } catch {
    // orphans only
  }
}

interface LiveSite {
  siteId: string;
  slug: string;
  versionId: string;
  takenDownAt: number | null;
  htmlSha256: string;
  pagesJson: string;
  documentJson: string;
}

/**
 * The site and its live version (Plan 2's readLiveSite): site_not_found for no such site, not_live for a site with no live version.
 * `takenDownFirst`: copyLivePagesAgain's order (site-state.ts:293-294 checks taken_down_at BEFORE not_live; restore checks not_live first, :155).
 */
async function liveSite(db: D1Database, siteId: string, takenDownFirst = false): Promise<LiveSite> {
  const site = await db
    .prepare("SELECT s.slug, s.taken_down_at, s.live_version_id, v.html_sha256, v.pages_json, v.document_json FROM sites s LEFT JOIN site_versions v ON v.id = s.live_version_id WHERE s.id = ?")
    .bind(siteId)
    .first<{ slug: string | null; taken_down_at: number | null; live_version_id: string | null; html_sha256: string | null; pages_json: string | null; document_json: string | null }>();
  if (site === null) throw new FakePublishError("site_not_found");
  if (takenDownFirst && site.taken_down_at !== null) throw new FakePublishError("site_taken_down");
  if (site.slug === null || site.live_version_id === null || site.document_json === null || site.pages_json === null || site.html_sha256 === null) throw new FakePublishError("not_live");
  return { siteId, slug: site.slug, versionId: site.live_version_id, takenDownAt: site.taken_down_at, htmlSha256: site.html_sha256, pagesJson: site.pages_json, documentJson: site.document_json };
}

/**
 * restore's take-back (site-state.ts:185-197 pointerBackIfDown): D1 is asked first (taken_down_at, live_version_id, admin_lock;
 * a read that throws counts as down). Down or gone: this call's own pointer goes (any pointer when holdsDownSite) and null is
 * returned; live: the pointer is left alone and the row is returned.
 */
async function pointerBackIfDown(env: { DB: D1Database; LIVE: R2Bucket }, site: LiveSite, writeId: string, token: string): Promise<(TakeBackRow & { live_version_id: string | null }) | null> {
  let after: (TakeBackRow & { live_version_id: string | null }) | null = null;
  try {
    after = await env.DB.prepare("SELECT taken_down_at, live_version_id, admin_lock FROM sites WHERE id = ?").bind(site.siteId).first<TakeBackRow & { live_version_id: string | null }>();
  } catch {
    // unconfirmed: treated as down
  }
  if (after === null || after.taken_down_at !== null) {
    await takeBackPointer(env.LIVE, site.slug, writeId, holdsDownSite(after, token));
    return null;
  }
  return after;
}

/**
 * Verifies every page of the live version, copies them to LIVE, checks the lease and writes the pointer (restore's own sequence,
 * site-state.ts:166-205). A rejected write may still have landed: still down, the pointer is taken back and the answer is
 * live_copy_failed; live (another restore won), the pointer is left and the answer is site_busy (lease_lost). Returns this call's writeId.
 */
async function copyAndWritePointer(env: { DB: D1Database; WORK: R2Bucket; LIVE: R2Bucket }, site: LiveSite, token: string): Promise<string> {
  const ids = { siteId: site.siteId, versionId: site.versionId };
  await copyPages(env.LIVE, site.slug, ids, await verifiedPages(env.WORK, { site_id: site.siteId, id: site.versionId, pages_json: site.pagesJson, html_sha256: site.htmlSha256 }));
  await holdsLease(env.DB, site.siteId, token);
  const writeId = newId(); // this call's own pointer write (site-state.ts:171)
  try {
    await writePointer(env.LIVE, site.slug, ids, site.documentJson, writeId);
  } catch {
    if ((await pointerBackIfDown(env, site, writeId, token)) === null) throw new FakePublishError("live_copy_failed", { versionId: site.versionId });
    throw new FakePublishError("site_busy", { reason: "lease_lost" });
  }
  return writeId;
}

/**
 * The copy-and-point sequence of a LIVE site (Plan 2's copyAndPoint, site-state.ts:235-270; used by copyLivePagesAgain and restore's heal): verify, copy,
 * lease check, pointer write under its own writeId (a rejection is remembered, the write may still have landed), then the takedown re-read
 * (taken_down_at and admin_lock): a read that throws takes this call's own pointer back out and answers live_copy_failed; a site down or gone
 * takes it back out (this call's own, or any pointer when the re-read shows the site down AND this call's token holding it: holdsDownSite) and
 * answers site_taken_down; a rejected write on a live site is live_copy_failed with the pointer left; otherwise the other versions' pages go.
 */
async function copyAndPoint(env: { DB: D1Database; WORK: R2Bucket; LIVE: R2Bucket }, site: LiveSite, token: string): Promise<void> {
  const ids = { siteId: site.siteId, versionId: site.versionId };
  await copyPages(env.LIVE, site.slug, ids, await verifiedPages(env.WORK, { site_id: site.siteId, id: site.versionId, pages_json: site.pagesJson, html_sha256: site.htmlSha256 }));
  await holdsLease(env.DB, site.siteId, token);
  const writeId = newId(); // this call's own pointer write (site-state.ts:248)
  let putRejected = false;
  try {
    await writePointer(env.LIVE, site.slug, ids, site.documentJson, writeId);
  } catch {
    putRejected = true; // the write may still have landed: the read below decides
  }
  let after: TakeBackRow | null;
  try {
    after = await env.DB.prepare("SELECT taken_down_at, admin_lock FROM sites WHERE id = ?").bind(site.siteId).first<TakeBackRow>();
  } catch {
    await takeBackPointer(env.LIVE, site.slug, writeId, false);
    throw new FakePublishError("live_copy_failed", { versionId: site.versionId });
  }
  if (after === null || after.taken_down_at !== null) {
    await takeBackPointer(env.LIVE, site.slug, writeId, holdsDownSite(after, token));
    throw new FakePublishError("site_taken_down");
  }
  if (putRejected) throw new FakePublishError("live_copy_failed", { versionId: site.versionId });
  await removeOtherVersions(env.LIVE, site.slug, site.versionId);
}

/** As Plan 2 decision 29: how many of the page's photos a takedown with purgeMedia deleted. */
async function missingPhotos(env: { MEDIA: R2Bucket; ROOT_DOMAIN: string }, documentJson: string): Promise<number> {
  const { facts } = JSON.parse(documentJson) as { facts: { heroPhoto?: { url: string }; photos?: Array<{ url: string }> } };
  const prefix = `https://media.${env.ROOT_DOMAIN}/`;
  const keys = [facts.heroPhoto, ...(facts.photos ?? [])].flatMap((p) => (p !== undefined && p.url.startsWith(prefix) ? [p.url.slice(prefix.length)] : []));
  return (await Promise.all(keys.map((key) => env.MEDIA.head(key)))).filter((o) => o === null).length;
}

/** Approve's work once the site's lease is held (Plan 2's approveUnderLease). */
async function approveUnderLease(env: Parameters<AdminPublishingDeps["approveVersion"]>[0], input: Parameters<AdminPublishingDeps["approveVersion"]>[1], token: string): ReturnType<AdminPublishingDeps["approveVersion"]> {
  const row = await env.DB.prepare(
    `SELECT v.id, v.site_id, v.html_sha256, v.pages_json, v.document_json, v.status, s.slug, s.pending_version_id, s.live_version_id, s.taken_down_at
     FROM site_versions v JOIN sites s ON s.id = v.site_id WHERE v.id = ?`,
  )
    .bind(input.versionId)
    .first<SiteVersionRow & { slug: string; pending_version_id: string | null; live_version_id: string | null; taken_down_at: number | null }>();
  if (row === null) throw new FakePublishError("version_not_pending");
  if (input.htmlSha256 !== row.html_sha256) throw new FakePublishError("integrity");
  // As Plan 2: a version that will be refused copies nothing; the accepted retry is approved, live and not taken down.
  const pendingOne = row.status === "pending" && row.pending_version_id === row.id;
  const acceptedRetry = row.status === "approved" && row.live_version_id === row.id;
  if (row.taken_down_at !== null) throw new FakePublishError("site_taken_down");
  if (!pendingOne && !acceptedRetry) throw new FakePublishError("version_not_pending");
  const ids = { siteId: row.site_id, versionId: row.id };
  await copyPages(env.LIVE, row.slug, ids, await verifiedPages(env.WORK, row));
  const [, version] = await env.DB.batch([
    env.DB.prepare("UPDATE sites SET live_version_id = ?, pending_version_id = NULL, indexable = ?, updated_at = ? WHERE id = ? AND pending_version_id = ? AND taken_down_at IS NULL AND admin_lock = ?")
      .bind(row.id, input.indexable ? 1 : 0, input.now, row.site_id, row.id, token),
    env.DB.prepare("UPDATE site_versions SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM sites WHERE id = ? AND live_version_id = ? AND admin_lock = ?)")
      .bind(input.reviewer, input.now, input.note, row.id, row.site_id, row.id, token),
    // Written only when the statement before it changed a row, so a retry logs nothing (Plan 2's auditIfChanged).
    env.DB.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?, ?, ?, ?, ? WHERE changes() = 1")
      .bind(input.now, `admin:${input.reviewer}`, "version.approved", row.site_id, JSON.stringify({ versionId: row.id, indexable: input.indexable })),
  ]);
  if (version?.meta.changes !== 1) {
    await holdsLease(env.DB, row.site_id, token); // a fenced write that changed nothing under a lost lease is not "already live"
    const now = await env.DB.prepare("SELECT v.status, s.live_version_id, s.taken_down_at FROM site_versions v JOIN sites s ON s.id = v.site_id WHERE v.id = ?")
      .bind(row.id)
      .first<{ status: string; live_version_id: string | null; taken_down_at: number | null }>();
    const alreadyLive = now !== null && now.status === "approved" && now.live_version_id === row.id && now.taken_down_at === null;
    if (!alreadyLive) throw new FakePublishError(now !== null && now.taken_down_at !== null ? "site_taken_down" : "version_not_pending");
  }
  await holdsLease(env.DB, row.site_id, token); // R2 cannot be conditioned on D1: the lease is checked right before the pointer write
  // The approval is recorded: a failed pointer write now is live_copy_failed, and approving again finishes it.
  const writeId = newId(); // this call's own pointer write (review.ts:101)
  let putRejected = false;
  try {
    await writePointer(env.LIVE, row.slug, ids, row.document_json, writeId);
  } catch {
    putRejected = true; // the write may still have landed: the read below decides, in both cases (review.ts:105-107)
  }
  let after: TakeBackRow | null;
  try {
    after = await env.DB.prepare("SELECT taken_down_at, admin_lock FROM sites WHERE id = ?").bind(row.site_id).first<TakeBackRow>();
  } catch {
    await takeBackPointer(env.LIVE, row.slug, writeId, false);
    throw new FakePublishError("live_copy_failed", { versionId: row.id });
  }
  if (after === null || after.taken_down_at !== null) {
    await takeBackPointer(env.LIVE, row.slug, writeId, holdsDownSite(after, token));
    throw new FakePublishError("site_taken_down");
  }
  if (putRejected) throw new FakePublishError("live_copy_failed", { versionId: row.id });
  await removeOtherVersions(env.LIVE, row.slug, row.id);
  return { siteId: row.site_id, slug: row.slug, liveUrl: siteUrl(env.ROOT_DOMAIN, row.slug) };
}

export const fakeAdminPublishing: AdminPublishingDeps = {
  PublishError: FakePublishError,
  async approveVersion(env, input) {
    // As Plan 2: the site's lease is taken first (a held site is site_busy), and every write below carries its token.
    const owner = await env.DB.prepare("SELECT site_id FROM site_versions WHERE id = ?").bind(input.versionId).first<{ site_id: string }>();
    if (owner === null) throw new FakePublishError("version_not_pending");
    return underLease(env.DB, owner.site_id, input.now, (token) => approveUnderLease(env, input, token), "version_not_pending");
  },
  async rejectVersion(env, input) {
    const version = await env.DB.prepare("SELECT site_id FROM site_versions WHERE id = ? AND status = 'pending'").bind(input.versionId).first<{ site_id: string }>();
    if (version === null) throw new FakePublishError("version_not_pending");
    await env.DB.batch([
      env.DB.prepare("UPDATE site_versions SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?").bind(input.reviewer, input.now, input.note, input.versionId),
      env.DB.prepare("UPDATE sites SET pending_version_id = NULL, updated_at = ? WHERE id = ? AND pending_version_id = ?").bind(input.now, version.site_id, input.versionId),
      audit(env.DB, input.now, input.reviewer, "version.rejected", version.site_id, { versionId: input.versionId }),
    ]);
    return { siteId: version.site_id };
  },
  async takeDown(env, input) {
    // As Plan 2 (site-state.ts:23-85): under the site's lease; every D1 write is fenced on it; the lease is checked right before each R2 delete
    // and after a batch that changed no row.
    return underLease(env.DB, input.siteId, input.now, async (token) => {
      const site = await env.DB.prepare("SELECT slug FROM sites WHERE id = ?").bind(input.siteId).first<{ slug: string | null }>();
      if (site === null) throw new FakePublishError("site_not_found");
      // Plan 2's order: (1) the LIVE pointer goes first, so every page stops at once (a failure here changes nothing in D1);
      // (2) the D1 batch; (3) the pointer again and every LIVE object under <slug>/; (4) the media purge.
      if (site.slug) {
        await holdsLease(env.DB, input.siteId, token);
        await env.LIVE.delete(livePointerKey(site.slug));
      }
      // As Plan 2 (site-state.ts): the UPDATE only takes the site down while it is up, so the first reason is kept,
      // and the audit row is written only when that UPDATE changed a row (auditIfChanged, WHERE changes() = 1).
      const [, takenDown] = await env.DB.batch([
        env.DB.prepare("UPDATE site_versions SET status = 'rejected', review_note = ? WHERE site_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM sites WHERE id = ? AND admin_lock = ?)").bind(TAKEDOWN_REVIEW_NOTE, input.siteId, input.siteId, token),
        env.DB.prepare("UPDATE sites SET taken_down_at = ?, takedown_reason = ?, pending_version_id = NULL WHERE id = ? AND taken_down_at IS NULL AND admin_lock = ?").bind(input.now, input.reason, input.siteId, token),
        env.DB.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?, ?, ?, ?, ? WHERE changes() = 1").bind(
          input.now,
          `admin:${input.reviewer}`,
          "site.taken_down",
          input.siteId,
          JSON.stringify({ reason: input.reason, purgeMedia: input.purgeMedia }),
        ),
      ]);
      if (takenDown?.meta.changes !== 1) await holdsLease(env.DB, input.siteId, token); // 0 rows: already down (fine) or the lease was lost
      if (site.slug) {
        await holdsLease(env.DB, input.siteId, token);
        await env.LIVE.delete(livePointerKey(site.slug));
        await holdsLease(env.DB, input.siteId, token);
        await deletePrefix(env.LIVE, liveSitePrefix(site.slug));
      }
      if (input.purgeMedia) {
        const listed = await env.MEDIA.list({ prefix: `${input.siteId}/` });
        await Promise.all(listed.objects.map((o) => env.MEDIA.delete(o.key)));
        const markDeleted = env.DB.prepare("UPDATE uploads SET deleted_at = ? WHERE site_id = ? AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM sites WHERE id = ? AND admin_lock = ?)").bind(input.now, input.siteId, input.siteId, token);
        // A later call's purge gets its own row, only when it marked an upload or deleted an object (Plan 2's auditLaterPurge).
        const firstCall = takenDown?.meta.changes === 1;
        const [marked] = await env.DB.batch(
          firstCall
            ? [markDeleted]
            : [
                markDeleted,
                env.DB.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?, ?, ?, ?, ? WHERE changes() > 0 OR ? > 0").bind(
                  input.now,
                  `admin:${input.reviewer}`,
                  "site.taken_down",
                  input.siteId,
                  JSON.stringify({ reason: input.reason, purgeMedia: true, repeat: true }),
                  listed.objects.length,
                ),
              ],
        );
        if (marked?.meta.changes === 0) await holdsLease(env.DB, input.siteId, token);
      }
    }, "site_not_found");
  },
  async restore(env, input) {
    return underLease(env.DB, input.siteId, input.now, async (token) => {
      const site = await liveSite(env.DB, input.siteId);
      const ids = { siteId: input.siteId, versionId: site.versionId };
      // As Plan 2: a site that is not taken down is "already restored": the normal result, and a missing or wrong pointer is healed.
      if (site.takenDownAt === null) {
        const pointer = await env.LIVE.head(livePointerKey(site.slug));
        const healed = pointer === null || pointer.customMetadata?.["versionId"] !== site.versionId;
        if (healed) await copyAndPoint(env, site, token);
        return { liveUrl: siteUrl(env.ROOT_DOMAIN, site.slug), missingPhotos: await missingPhotos(env, site.documentJson), healed };
      }
      // Taken down again since the admin's page was shown: the admin decides again, on a fresh page.
      if (site.takenDownAt !== input.expectedTakenDownAt) throw new FakePublishError("site_taken_down", { reason: "taken_down_again" });
      // Verify every page, copy them, write the pointer (not served yet: D1 still says taken down), then clear taken_down_at.
      const writeId = await copyAndWritePointer(env, site, token);
      let cleared: Array<{ meta: { changes: number } }> | null;
      try {
        // The pinned fenced clear (RESTORE_SITE_SQL = site-state.ts:209): taken_down_at, live version and lease must all still match.
        cleared = await env.DB.batch([
          env.DB.prepare(RESTORE_SITE_SQL).bind(input.now, input.siteId, input.expectedTakenDownAt, ids.versionId, token),
          env.DB.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) SELECT ?, ?, ?, ?, ? WHERE changes() = 1").bind(input.now, `admin:${input.reviewer}`, "site.restored", input.siteId, JSON.stringify({ versionId: ids.versionId })),
        ]);
      } catch (error) {
        // D1 can commit a batch and still throw (site-state.ts:213-220): D1 is asked; a committed clear keeps the pointer, a clear that
        // is not there takes the pointer back out and rethrows, another version live is site_busy (lease_lost).
        const after = await pointerBackIfDown(env, site, writeId, token);
        if (after === null) throw error;
        if (after.live_version_id !== site.versionId) throw new FakePublishError("site_busy", { reason: "lease_lost" });
        cleared = null; // the clear committed: keep the pointer (site-state.ts:220)
      }
      if (cleared !== null && cleared[0]?.meta.changes !== 1) {
        // site-state.ts:221-224: the fenced clear changed no row (the lease was lost): down, the pointer is taken back; live (another restore won), left alone.
        await pointerBackIfDown(env, site, writeId, token);
        throw new FakePublishError("site_busy", { reason: "lease_lost" });
      }
      await removeOtherVersions(env.LIVE, site.slug, site.versionId);
      return { liveUrl: siteUrl(env.ROOT_DOMAIN, site.slug), missingPhotos: await missingPhotos(env, site.documentJson), healed: false };
    });
  },
  async copyLivePagesAgain(env, input) {
    return underLease(env.DB, input.siteId, input.now, async (token) => {
      // As Plan 2 (site-state.ts:289-297): taken down is checked BEFORE not live; never touches taken_down_at, changes no D1 row and writes no audit row.
      const site = await liveSite(env.DB, input.siteId, true);
      await copyAndPoint(env, site, token);
      return { liveUrl: siteUrl(env.ROOT_DOMAIN, site.slug) };
    });
  },
  async setIndexable(env, input) {
    const site = await env.DB.prepare("SELECT 1 AS found FROM sites WHERE id = ?").bind(input.siteId).first();
    if (site === null) throw new FakePublishError("site_not_found");
    await env.DB.batch([
      env.DB.prepare("UPDATE sites SET indexable = ? WHERE id = ?").bind(input.indexable ? 1 : 0, input.siteId),
      audit(env.DB, input.now, input.reviewer, "site.indexable_changed", input.siteId, { indexable: input.indexable }),
    ]);
  },
};

/**
 * Plan 3's settings helpers, as §6.4 describes them. The worst case is a fixed test figure, and null
 * (no recorded price, Plan 3 decision 11) for the model id "unpriced-model".
 */
export const fakeAdminGeneration: AdminGenerationDeps = {
  async dailyModelLimit(env) {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'generation.daily_model_limit'").first<{ value: string }>();
    return Number(row?.value ?? env.DAILY_MODEL_LIMIT);
  },
  worstCaseJobMicrousd: (_provider, modelId) => (modelId === "unpriced-model" ? null : 336_000),
  toGenerationView,
};

/**
 * The app's fake mailer (an address at @mail-fails.example fails as Plan 2's MailerError "rejected"), plus
 * the admin's own case: an address at @mail-rate-limited.example fails as "rate_limited", the code for every
 * Resend 429 (§7.6), which the invite route explains to the admin in its own words.
 */
export function fakeAdminCreateMailer(env: MailerEnv): Mailer {
  const mailer = fakeCreateMailer(env);
  return {
    async send(email) {
      if (email.to.endsWith("@mail-rate-limited.example")) throw Object.assign(new Error("rate_limited"), { name: "MailerError", code: "rate_limited" });
      return mailer.send(email);
    },
  };
}

export const fakeAdminDeps: AdminDeps = { publishing: fakeAdminPublishing, generation: fakeAdminGeneration, createMailer: fakeAdminCreateMailer };
