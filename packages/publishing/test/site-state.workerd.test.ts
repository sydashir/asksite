import { livePageKey, livePointerKey, mediaKey, mediaUrl, newId, versionKey, versionPageKey } from "@asksite/core";
import { SiteDocument } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveVersion, copyLivePagesAgain, createPendingVersion, restore, setIndexable, TAKEDOWN_REVIEW_NOTE, takeDown } from "../src/index.ts";
import { publishFailure as failure } from "./support/errors.ts";
import { auditActions, doc, EDITS, flakyBucket, liveKeysOf, pendingWithPages, publishingHarness, ROOT, seedSite, siteRow, versionRow, type PublishEnv } from "./support/harness.ts";

const harness = publishingHarness("publishing-site-state-test");
let env: PublishEnv;
beforeAll(async () => {
  env = await harness.start();
}, 120_000);
afterAll(async () => {
  await harness.server.close();
});

const ADMIN = "admin@example.com";

/** A live site (version 1 approved) and, optionally, version 2 in review. */
async function liveSite(withPending = false) {
  const site = await seedSite(env.DB);
  const v1 = await createPendingVersion(env, { ...site, document: doc(), edits: EDITS, generationId: null, now: 1 });
  const sha = String((await versionRow(env.DB, v1.id))?.html_sha256);
  await approveVersion(env, { versionId: v1.id, htmlSha256: sha, reviewer: ADMIN, note: null, indexable: true, now: 2 });
  const v2 = withPending ? await createPendingVersion(env, { ...site, document: doc("hvac-phoenix"), edits: EDITS, generationId: null, now: 3 }) : null;
  return { ...site, liveVersionId: v1.id, pendingVersionId: v2?.id ?? null };
}

async function addUpload(siteId: string): Promise<string> {
  const uploadId = newId();
  await env.DB.prepare("INSERT INTO uploads (id, site_id, width, height, bytes, created_at) VALUES (?, ?, 1600, 1200, 4, 1)").bind(uploadId, siteId).run();
  await env.MEDIA.put(mediaKey(siteId, uploadId), "webp");
  return uploadId;
}

describe("takeDown", () => {
  it("marks the site taken down in D1, rejects the pending version and deletes the pointer and the live pages", async () => {
    const s = await liveSite(true);
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "Phishing", purgeMedia: false, now: 50 });
    expect(await siteRow(env.DB, s.siteId)).toMatchObject({ taken_down_at: 50, takedown_reason: "Phishing", pending_version_id: null, live_version_id: s.liveVersionId });
    expect(await versionRow(env.DB, String(s.pendingVersionId))).toMatchObject({ status: "rejected", review_note: TAKEDOWN_REVIEW_NOTE, reviewed_by: ADMIN });
    // Plan 4 tells a takedown's automatic rejection from a real review by this exact note (the same bytes as always).
    expect(TAKEDOWN_REVIEW_NOTE).toBe("Site taken down");
    expect(await liveKeysOf(env.LIVE, s.slug)).toEqual([]);
    expect(await auditActions(env.DB, s.siteId)).toEqual(["version.requested", "version.approved", "version.requested", "site.taken_down"]);
  });

  it("is idempotent and keeps the first takedown time", async () => {
    const s = await liveSite();
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "Spam", purgeMedia: false, now: 50 });
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "Spam again", purgeMedia: false, now: 60 });
    expect(await siteRow(env.DB, s.siteId)).toMatchObject({ taken_down_at: 50, takedown_reason: "Spam" });
    expect((await auditActions(env.DB, s.siteId)).filter((a) => a === "site.taken_down")).toHaveLength(1);
  });

  it("purges only this site's photos when asked", async () => {
    const s = await liveSite();
    const other = await liveSite();
    const mine = [await addUpload(s.siteId), await addUpload(s.siteId)];
    const theirs = await addUpload(other.siteId);
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "Abuse", purgeMedia: true, now: 70 });
    for (const id of mine) expect(await env.MEDIA.get(mediaKey(s.siteId, id))).toBeNull();
    expect(await env.MEDIA.get(mediaKey(other.siteId, theirs))).not.toBeNull();
    const { results } = await env.DB.prepare("SELECT deleted_at FROM uploads WHERE site_id = ?").bind(s.siteId).all<{ deleted_at: number | null }>();
    expect(results.map((r) => r.deleted_at)).toEqual([70, 70]);
    const { results: kept } = await env.DB.prepare("SELECT deleted_at FROM uploads WHERE site_id = ?").bind(other.siteId).all<{ deleted_at: number | null }>();
    expect(kept.map((r) => r.deleted_at)).toEqual([null]);
  });
});

describe("an unknown site id", () => {
  it("gets site_not_found from takeDown, restore and setIndexable (Plan 4 answers 404)", async () => {
    const siteId = newId();
    expect((await failure(takeDown(env, { siteId, reviewer: ADMIN, reason: "x", purgeMedia: false, now: 1 }))).code).toBe("site_not_found");
    expect((await failure(restore(env, { siteId, reviewer: ADMIN, expectedTakenDownAt: 0, now: 1 }))).code).toBe("site_not_found");
    expect((await failure(setIndexable(env, { siteId, reviewer: ADMIN, indexable: false, now: 1 }))).code).toBe("site_not_found");
  });
});

describe("restore", () => {
  it("puts the live version's pages and pointer back, then clears the takedown", async () => {
    const s = await liveSite();
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "Mistake", purgeMedia: false, now: 50 });
    expect(await restore(env, { siteId: s.siteId, reviewer: ADMIN, expectedTakenDownAt: 50, now: 60 })).toEqual({ liveUrl: `https://${s.slug}.asksite.example/`, missingPhotos: 0 });
    const work = await (await env.WORK.get(versionKey(s.siteId, s.liveVersionId)))?.text();
    expect(await (await env.LIVE.get(livePageKey(s.slug, s.liveVersionId, "home")))?.text()).toBe(work);
    expect((await env.LIVE.head(livePointerKey(s.slug)))?.customMetadata?.["versionId"]).toBe(s.liveVersionId);
    expect(await siteRow(env.DB, s.siteId)).toMatchObject({ taken_down_at: null, takedown_reason: null });
    expect((await auditActions(env.DB, s.siteId)).slice(-2)).toEqual(["site.taken_down", "site.restored"]);
  });

  it("is retry-safe and audits once", async () => {
    const s = await liveSite();
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "x", purgeMedia: false, now: 50 });
    await restore(env, { siteId: s.siteId, reviewer: ADMIN, expectedTakenDownAt: 50, now: 60 });
    await restore(env, { siteId: s.siteId, reviewer: ADMIN, expectedTakenDownAt: 50, now: 61 });
    expect((await auditActions(env.DB, s.siteId)).filter((a) => a === "site.restored")).toHaveLength(1);
  });

  it("refuses a site that was never live", async () => {
    const site = await seedSite(env.DB);
    expect((await failure(restore(env, { siteId: site.siteId, reviewer: ADMIN, expectedTakenDownAt: 0, now: 1 }))).code).toBe("not_live");
  });

  it("counts the photos a purge deleted, so the admin knows the page will show broken images", async () => {
    const site = await seedSite(env.DB);
    const photos = [await addUpload(site.siteId), await addUpload(site.siteId)].map((id) => ({ url: mediaUrl(ROOT, site.siteId, id), alt: "A finished job", width: 1600, height: 1200 }));
    const base = doc("plumber-austin");
    const document = SiteDocument.parse({ ...base, facts: { ...base.facts, heroPhoto: photos[0], photos: [photos[1]] } });
    const v1 = await createPendingVersion(env, { ...site, document, edits: EDITS, generationId: null, now: 1 });
    await approveVersion(env, { versionId: v1.id, htmlSha256: String((await versionRow(env.DB, v1.id))?.html_sha256), reviewer: ADMIN, note: null, indexable: true, now: 2 });
    await takeDown(env, { siteId: site.siteId, reviewer: ADMIN, reason: "Abuse", purgeMedia: true, now: 3 });
    expect(await restore(env, { siteId: site.siteId, reviewer: ADMIN, expectedTakenDownAt: 3, now: 4 })).toEqual({ liveUrl: `https://${site.slug}.asksite.example/`, missingPhotos: 2 });
    expect((await siteRow(env.DB, site.siteId))?.taken_down_at).toBeNull();
  });

  it("refuses when the stored bytes no longer match, and leaves the site taken down", async () => {
    const s = await liveSite();
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "x", purgeMedia: false, now: 50 });
    await env.WORK.put(versionKey(s.siteId, s.liveVersionId), "tampered");
    expect((await failure(restore(env, { siteId: s.siteId, reviewer: ADMIN, expectedTakenDownAt: 50, now: 60 }))).code).toBe("integrity");
    expect((await siteRow(env.DB, s.siteId))?.taken_down_at).toBe(50);
    expect(await liveKeysOf(env.LIVE, s.slug)).toEqual([]);
  });
});

describe("setIndexable", () => {
  it("switches search engines off and on in D1, auditing only real changes", async () => {
    const s = await liveSite();
    await setIndexable(env, { siteId: s.siteId, reviewer: ADMIN, indexable: false, now: 5 });
    expect((await siteRow(env.DB, s.siteId))?.indexable).toBe(0);
    await setIndexable(env, { siteId: s.siteId, reviewer: ADMIN, indexable: false, now: 6 });
    await setIndexable(env, { siteId: s.siteId, reviewer: ADMIN, indexable: true, now: 7 });
    expect((await siteRow(env.DB, s.siteId))?.indexable).toBe(1);
    expect((await auditActions(env.DB, s.siteId)).filter((a) => a === "site.indexable_changed")).toHaveLength(2);
  });
});

describe("what takedown, restore and the search switch change and record (design §7.2)", () => {
  const auditRows = async (siteId: string) =>
    (await env.DB.prepare("SELECT at, actor, action, detail_json FROM audit_log WHERE site_id = ? ORDER BY id").bind(siteId).all<{ detail_json: string }>())
      .results.map((row) => ({ ...row, detail_json: JSON.parse(row.detail_json) as unknown }));
  const updatedAt = (siteId: string) => env.DB.prepare("SELECT updated_at FROM sites WHERE id = ?").bind(siteId).first("updated_at");
  const uploadsDeletedAt = async (siteId: string) =>
    new Map((await env.DB.prepare("SELECT id, deleted_at FROM uploads WHERE site_id = ?").bind(siteId).all<{ id: string; deleted_at: number | null }>()).results.map((u) => [u.id, u.deleted_at]));

  /** A live site whose page shows two of its own photos: the hero and one in the gallery. */
  async function liveSiteWithPhotos() {
    const site = await seedSite(env.DB);
    const hero = await addUpload(site.siteId);
    const gallery = await addUpload(site.siteId);
    const photo = (id: string) => ({ url: mediaUrl(ROOT, site.siteId, id), alt: "A finished job", width: 1600, height: 1200 });
    const base = doc("plumber-austin");
    const document = SiteDocument.parse({ ...base, facts: { ...base.facts, heroPhoto: photo(hero), photos: [photo(gallery)] } });
    const v1 = await createPendingVersion(env, { ...site, document, edits: EDITS, generationId: null, now: 1 });
    await approveVersion(env, { versionId: v1.id, htmlSha256: String((await versionRow(env.DB, v1.id))?.html_sha256), reviewer: ADMIN, note: null, indexable: true, now: 2 });
    return { ...site, liveVersionId: v1.id, hero, gallery };
  }

  it("a takedown rejects only this site's version in review, never the live one, and records when", async () => {
    const s = await liveSite(true);
    const other = await liveSite(true);
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "Phishing", purgeMedia: false, now: 50 });
    expect(await versionRow(env.DB, s.liveVersionId)).toMatchObject({ status: "approved", reviewed_at: 2 });
    expect(await versionRow(env.DB, String(s.pendingVersionId))).toMatchObject({ status: "rejected", reviewed_at: 50 });
    expect(await versionRow(env.DB, String(other.pendingVersionId))).toMatchObject({ status: "pending", reviewed_by: null, reviewed_at: null, review_note: null });
    expect(await siteRow(env.DB, other.siteId)).toMatchObject({ taken_down_at: null, pending_version_id: other.pendingVersionId });
  });

  it("each change is logged as the admin's, with its detail, and stamps the site", async () => {
    const s = await liveSite();
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "Spam", purgeMedia: true, now: 50 });
    expect(await updatedAt(s.siteId)).toBe(50);
    await restore(env, { siteId: s.siteId, reviewer: ADMIN, expectedTakenDownAt: 50, now: 60 });
    expect(await updatedAt(s.siteId)).toBe(60);
    await setIndexable(env, { siteId: s.siteId, reviewer: ADMIN, indexable: false, now: 70 });
    expect(await updatedAt(s.siteId)).toBe(70);
    expect((await auditRows(s.siteId)).slice(2)).toEqual([
      { at: 50, actor: "admin:admin@example.com", action: "site.taken_down", detail_json: { reason: "Spam", purgeMedia: true } },
      { at: 60, actor: "admin:admin@example.com", action: "site.restored", detail_json: { versionId: s.liveVersionId } },
      { at: 70, actor: "admin:admin@example.com", action: "site.indexable_changed", detail_json: { indexable: false } },
    ]);
  });

  it("a takedown without purgeMedia keeps the photos, so a restore finds none missing", async () => {
    const s = await liveSiteWithPhotos();
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "Mistake", purgeMedia: false, now: 50 });
    for (const id of [s.hero, s.gallery]) expect(await env.MEDIA.head(mediaKey(s.siteId, id))).not.toBeNull();
    expect([...(await uploadsDeletedAt(s.siteId)).values()]).toEqual([null, null]);
    expect(await restore(env, { siteId: s.siteId, reviewer: ADMIN, expectedTakenDownAt: 50, now: 60 })).toEqual({ liveUrl: `https://${s.slug}.asksite.example/`, missingPhotos: 0 });
  });

  it("counts only the page's photos that are really gone", async () => {
    const s = await liveSiteWithPhotos();
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "x", purgeMedia: false, now: 50 });
    await env.MEDIA.delete(mediaKey(s.siteId, s.hero));
    expect((await restore(env, { siteId: s.siteId, reviewer: ADMIN, expectedTakenDownAt: 50, now: 60 })).missingPhotos).toBe(1);
  });

  it("a purge deletes every photo, however many pages the listing takes", async () => {
    const s = await liveSite();
    const ids = [await addUpload(s.siteId), await addUpload(s.siteId), await addUpload(s.siteId)];
    let lists = 0;
    // R2 lists at most 1,000 keys a call; one key a page walks the same cursor loop with three photos.
    const paged = {
      list: (options?: R2ListOptions) => ((lists += 1), env.MEDIA.list({ ...options, limit: 1 })),
      delete: (keys: string | string[]) => env.MEDIA.delete(keys),
    } as unknown as R2Bucket;
    await takeDown({ ...env, MEDIA: paged }, { siteId: s.siteId, reviewer: ADMIN, reason: "Abuse", purgeMedia: true, now: 70 });
    for (const id of ids) expect(await env.MEDIA.head(mediaKey(s.siteId, id))).toBeNull();
    expect(lists).toBeGreaterThanOrEqual(3);
  });

  it("a purge keeps the time a photo was already deleted", async () => {
    const s = await liveSite();
    const earlier = await addUpload(s.siteId);
    const later = await addUpload(s.siteId);
    await env.DB.prepare("UPDATE uploads SET deleted_at = 5 WHERE id = ?").bind(earlier).run();
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "Abuse", purgeMedia: true, now: 70 });
    const deletedAt = await uploadsDeletedAt(s.siteId);
    expect([deletedAt.get(earlier), deletedAt.get(later)]).toEqual([5, 70]);
  });

  it("puts the page and the pointer back with the metadata the sites Worker checks (Decision 24)", async () => {
    const s = await liveSite();
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "x", purgeMedia: false, now: 50 });
    await restore(env, { siteId: s.siteId, reviewer: ADMIN, expectedTakenDownAt: 50, now: 60 });
    const page = await env.LIVE.head(livePageKey(s.slug, s.liveVersionId, "home"));
    expect(page?.httpMetadata?.contentType).toBe("text/html; charset=utf-8");
    const [home] = JSON.parse(String((await versionRow(env.DB, s.liveVersionId))?.pages_json)) as Array<{ sha256: string }>;
    expect(page?.customMetadata).toEqual({ siteId: s.siteId, versionId: s.liveVersionId, page: "home", sha256: home?.sha256 });
    const live = await env.LIVE.head(livePointerKey(s.slug));
    expect(live?.customMetadata).toEqual({
      siteId: s.siteId, versionId: s.liveVersionId,
      businessName: "Reliable Rooter Plumbing", // QA-2 RU(2): the live document's business name (plumber-austin)
      phoneText: "(512) 555-0142", phoneTel: "+15125550142", // A15: the live document's business phone (plumber-austin)
    });
  });

  it("writes the pages and the pointer before clearing the takedown: if a write fails, the site stays down", async () => {
    const s = await liveSite();
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "x", purgeMedia: false, now: 50 });
    for (const failing of [flakyBucket(env.LIVE, (call) => call === "put"), flakyBucket(env.LIVE, (call, key) => call === "put" && key === livePointerKey(s.slug))]) {
      await expect(restore({ ...env, LIVE: failing }, { siteId: s.siteId, reviewer: ADMIN, expectedTakenDownAt: 50, now: 60 })).rejects.toThrow("R2 is unavailable");
    }
    expect(await siteRow(env.DB, s.siteId)).toMatchObject({ taken_down_at: 50, takedown_reason: "x" });
    expect(await auditActions(env.DB, s.siteId)).not.toContain("site.restored");
  });

  it("names why the stored bytes were refused (a missing page too)", async () => {
    const tampered = await liveSite();
    const missing = await liveSite();
    for (const s of [tampered, missing]) await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "x", purgeMedia: false, now: 50 });
    await env.WORK.put(versionKey(tampered.siteId, tampered.liveVersionId), "tampered");
    await env.WORK.delete(versionKey(missing.siteId, missing.liveVersionId));
    for (const s of [tampered, missing]) {
      const error = await failure(restore(env, { siteId: s.siteId, reviewer: ADMIN, expectedTakenDownAt: 50, now: 60 }));
      expect({ code: error.code, detail: error.detail }).toEqual({ code: "integrity", detail: { reason: "stored_bytes_mismatch" } });
      expect(await siteRow(env.DB, s.siteId)).toMatchObject({ taken_down_at: 50 });
    }
  });
});

describe("a later takedown call that deletes photos is logged too (design §4.5: every state change writes a row)", () => {
  const SECOND = "second@example.com";
  const takedownRows = async (siteId: string) =>
    (await env.DB.prepare("SELECT at, actor, detail_json FROM audit_log WHERE site_id = ? AND action = 'site.taken_down' ORDER BY id").bind(siteId).all<{ at: number; actor: string; detail_json: string }>())
      .results.map((row) => ({ at: row.at, actor: row.actor, detail: JSON.parse(row.detail_json) as unknown }));

  it("records a second admin's purge of a site that was already down, and keeps the first takedown", async () => {
    const s = await liveSite();
    const photos = [await addUpload(s.siteId), await addUpload(s.siteId)];
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "Spam", purgeMedia: false, now: 50 });
    await takeDown(env, { siteId: s.siteId, reviewer: SECOND, reason: "Photos too", purgeMedia: true, now: 60 });
    for (const id of photos) expect(await env.MEDIA.head(mediaKey(s.siteId, id))).toBeNull();
    expect(await siteRow(env.DB, s.siteId)).toMatchObject({ taken_down_at: 50, takedown_reason: "Spam" });
    expect(await takedownRows(s.siteId)).toEqual([
      { at: 50, actor: `admin:${ADMIN}`, detail: { reason: "Spam", purgeMedia: false } },
      { at: 60, actor: `admin:${SECOND}`, detail: { reason: "Photos too", purgeMedia: true, repeat: true } },
    ]);
  });

  it("records it when only a soft-deleted photo's kept object goes (design §8), or only an upload row changes", async () => {
    const soft = await liveSite();
    const kept = await addUpload(soft.siteId);
    await env.DB.prepare("UPDATE uploads SET deleted_at = 5 WHERE id = ?").bind(kept).run();
    const rowOnly = await liveSite();
    const neverStored = await addUpload(rowOnly.siteId);
    await env.MEDIA.delete(mediaKey(rowOnly.siteId, neverStored));
    for (const s of [soft, rowOnly]) {
      await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "x", purgeMedia: false, now: 50 });
      await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "y", purgeMedia: true, now: 60 });
      expect((await takedownRows(s.siteId)).map((row) => row.detail)).toEqual([
        { reason: "x", purgeMedia: false },
        { reason: "y", purgeMedia: true, repeat: true },
      ]);
    }
    expect(await env.MEDIA.head(mediaKey(soft.siteId, kept))).toBeNull();
    const deletedAt = (id: string) => env.DB.prepare("SELECT deleted_at FROM uploads WHERE id = ?").bind(id).first("deleted_at");
    expect([await deletedAt(kept), await deletedAt(neverStored)]).toEqual([5, 60]);
  });

  it("records a retry that finishes a purge the first call could not", async () => {
    const s = await liveSite();
    const photo = await addUpload(s.siteId);
    const failing = { list: (options?: R2ListOptions) => env.MEDIA.list(options), delete: () => Promise.reject(new Error("R2 is unavailable")) } as unknown as R2Bucket;
    await expect(takeDown({ ...env, MEDIA: failing }, { siteId: s.siteId, reviewer: ADMIN, reason: "Abuse", purgeMedia: true, now: 50 })).rejects.toThrow("R2 is unavailable");
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "Abuse", purgeMedia: true, now: 60 });
    expect(await env.MEDIA.head(mediaKey(s.siteId, photo))).toBeNull();
    expect(await takedownRows(s.siteId)).toEqual([
      { at: 50, actor: `admin:${ADMIN}`, detail: { reason: "Abuse", purgeMedia: true } },
      { at: 60, actor: `admin:${ADMIN}`, detail: { reason: "Abuse", purgeMedia: true, repeat: true } },
    ]);
  });

  it("writes one row for a first call that purges, and none for a repeat that deletes nothing", async () => {
    const purged = await liveSite();
    await addUpload(purged.siteId);
    await takeDown(env, { siteId: purged.siteId, reviewer: ADMIN, reason: "Abuse", purgeMedia: true, now: 50 });
    await takeDown(env, { siteId: purged.siteId, reviewer: SECOND, reason: "Abuse", purgeMedia: true, now: 60 });
    expect(await takedownRows(purged.siteId)).toEqual([{ at: 50, actor: `admin:${ADMIN}`, detail: { reason: "Abuse", purgeMedia: true } }]);
    const bare = await liveSite();
    await takeDown(env, { siteId: bare.siteId, reviewer: ADMIN, reason: "x", purgeMedia: false, now: 50 });
    await takeDown(env, { siteId: bare.siteId, reviewer: SECOND, reason: "y", purgeMedia: true, now: 60 });
    expect(await takedownRows(bare.siteId)).toHaveLength(1);
  });
});

// A16 + U2: the pointer is what makes a site visible, so a takedown deletes it first and a restore writes it last.
describe("takedown and restore on the pointer (A16)", () => {
  /** A live site whose version has several pages (built by hand: the renderer gives one page for now). */
  async function liveMultiPage(pages: Parameters<typeof pendingWithPages>[1] = ["home", "services", "about", "contact"], slug?: string) {
    const p = await pendingWithPages(env, pages, slug);
    await approveVersion(env, { versionId: p.versionId, htmlSha256: p.htmlSha256, reviewer: ADMIN, note: null, indexable: true, now: 2 });
    return p;
  }
  const taken = (siteId: string) => takeDown(env, { siteId, reviewer: ADMIN, reason: "Spam", purgeMedia: false, now: 50 });

  it("deletes the pointer first: if that fails, the takedown fails with nothing changed in D1", async () => {
    const p = await liveMultiPage();
    const before = { site: await siteRow(env.DB, p.siteId), audit: await auditActions(env.DB, p.siteId), keys: await liveKeysOf(env.LIVE, p.slug) };
    const pointerStays = flakyBucket(env.LIVE, (call, arg) => call === "delete" && arg === livePointerKey(p.slug));
    await expect(takeDown({ ...env, LIVE: pointerStays }, { siteId: p.siteId, reviewer: ADMIN, reason: "Spam", purgeMedia: false, now: 50 })).rejects.toThrow("R2 is unavailable");
    expect({ site: await siteRow(env.DB, p.siteId), audit: await auditActions(env.DB, p.siteId), keys: await liveKeysOf(env.LIVE, p.slug) }).toEqual(before);
    await taken(p.siteId); // the admin's retry
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: 50 });
  });

  it("stops serving before it changes D1", async () => {
    const p = await liveMultiPage();
    let atPointerDelete: { pointer: R2Object | null; takenDownAt: number | null | undefined } | undefined;
    const watching = {
      delete: async (keys: string | string[]) => {
        if (keys === livePointerKey(p.slug) && atPointerDelete === undefined) atPointerDelete = { pointer: await env.LIVE.head(keys), takenDownAt: (await siteRow(env.DB, p.siteId))?.taken_down_at };
        return env.LIVE.delete(keys);
      },
      list: (options?: R2ListOptions) => env.LIVE.list(options),
    } as unknown as R2Bucket;
    await takeDown({ ...env, LIVE: watching }, { siteId: p.siteId, reviewer: ADMIN, reason: "Spam", purgeMedia: false, now: 50 });
    expect(atPointerDelete?.pointer).not.toBeNull();
    expect(atPointerDelete?.takenDownAt).toBeNull(); // D1 was still untouched when the pointer first went
  });

  it("leaves no pointer and no page of the site, and not another site's, and a second call is a no-op", async () => {
    const p = await liveMultiPage();
    const other = await liveMultiPage(["home", "gallery", "contact"], `${p.slug}s`); // its slug starts with the first site's
    await taken(p.siteId);
    expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([]);
    expect(await liveKeysOf(env.LIVE, other.slug)).toEqual([livePointerKey(other.slug), ...other.pages.map((page) => livePageKey(other.slug, other.versionId, page.page))].sort());
    const audit = await auditActions(env.DB, p.siteId);
    await taken(p.siteId);
    expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([]);
    expect(await auditActions(env.DB, p.siteId)).toEqual(audit);
  });

  it("throws when the pages cannot be deleted after D1 changed, and the retry finishes", async () => {
    const p = await liveMultiPage();
    const pagesStay = flakyBucket(env.LIVE, (call, arg) => call === "delete" && Array.isArray(arg));
    await expect(takeDown({ ...env, LIVE: pagesStay }, { siteId: p.siteId, reviewer: ADMIN, reason: "Spam", purgeMedia: false, now: 50 })).rejects.toThrow("R2 is unavailable");
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: 50 });
    expect(await env.LIVE.head(livePointerKey(p.slug))).toBeNull();
    await taken(p.siteId);
    expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([]);
  });

  it("restores every page and the pointer", async () => {
    const p = await liveMultiPage();
    await taken(p.siteId);
    await restore(env, { siteId: p.siteId, reviewer: ADMIN, expectedTakenDownAt: 50, now: 60 });
    expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([livePointerKey(p.slug), ...p.pages.map((page) => livePageKey(p.slug, p.versionId, page.page))].sort());
    for (const page of p.pages) expect(await (await env.LIVE.get(livePageKey(p.slug, p.versionId, page.page)))?.text()).toBe(page.html);
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: null });
  });

  it.each([
    ["a tampered page", (p: Awaited<ReturnType<typeof liveMultiPage>>) => env.WORK.put(versionPageKey(p.siteId, p.versionId, "about"), "<p>tampered</p>")],
    ["a missing page", (p: Awaited<ReturnType<typeof liveMultiPage>>) => env.WORK.delete(versionPageKey(p.siteId, p.versionId, "contact"))],
    ["a pages_json that is not valid", (p: Awaited<ReturnType<typeof liveMultiPage>>) => env.DB.prepare("UPDATE site_versions SET pages_json = '[]' WHERE id = ?").bind(p.versionId).run()],
  ])("refuses %s and the site stays down", async (_name, damage) => {
    const p = await liveMultiPage();
    await taken(p.siteId);
    await damage(p);
    expect((await failure(restore(env, { siteId: p.siteId, reviewer: ADMIN, expectedTakenDownAt: 50, now: 60 }))).code).toBe("integrity");
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: 50 });
    expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([]);
    expect(await auditActions(env.DB, p.siteId)).not.toContain("site.restored");
  });

  it("copyLivePagesAgain on a live site copies the pages again and rewrites the pointer: no D1 change, no audit row", async () => {
    const p = await liveMultiPage();
    await env.LIVE.delete([livePointerKey(p.slug), livePageKey(p.slug, p.versionId, "about")]);
    await env.LIVE.put(livePageKey(p.slug, p.versionId, "services"), "damaged");
    const before = { site: await siteRow(env.DB, p.siteId), version: await versionRow(env.DB, p.versionId), audit: await auditActions(env.DB, p.siteId) };
    await copyLivePagesAgain(env, { siteId: p.siteId, reviewer: ADMIN, now: 99 });
    expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([livePointerKey(p.slug), ...p.pages.map((page) => livePageKey(p.slug, p.versionId, page.page))].sort());
    for (const page of p.pages) expect(await (await env.LIVE.get(livePageKey(p.slug, p.versionId, page.page)))?.text()).toBe(page.html);
    expect({ site: await siteRow(env.DB, p.siteId), version: await versionRow(env.DB, p.versionId), audit: await auditActions(env.DB, p.siteId) }).toEqual(before);
  });
});
