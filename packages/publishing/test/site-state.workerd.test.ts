import { liveKey, mediaKey, mediaUrl, newId, versionKey } from "@asksite/core";
import { SiteDocument } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveVersion, createPendingVersion, restore, setIndexable, takeDown } from "../src/index.ts";
import { publishFailure as failure } from "./support/errors.ts";
import { auditActions, doc, EDITS, publishingHarness, ROOT, seedSite, siteRow, versionRow, type PublishEnv } from "./support/harness.ts";

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
  it("marks the site taken down in D1, rejects the pending version and deletes the live copy", async () => {
    const s = await liveSite(true);
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "Phishing", purgeMedia: false, now: 50 });
    expect(await siteRow(env.DB, s.siteId)).toMatchObject({ taken_down_at: 50, takedown_reason: "Phishing", pending_version_id: null, live_version_id: s.liveVersionId });
    expect(await versionRow(env.DB, String(s.pendingVersionId))).toMatchObject({ status: "rejected", review_note: "Site taken down", reviewed_by: ADMIN });
    expect(await env.LIVE.get(liveKey(s.slug))).toBeNull();
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
    expect((await failure(restore(env, { siteId, reviewer: ADMIN, now: 1 }))).code).toBe("site_not_found");
    expect((await failure(setIndexable(env, { siteId, reviewer: ADMIN, indexable: false, now: 1 }))).code).toBe("site_not_found");
  });
});

describe("restore", () => {
  it("puts the live version's bytes back, then clears the takedown", async () => {
    const s = await liveSite();
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "Mistake", purgeMedia: false, now: 50 });
    expect(await restore(env, { siteId: s.siteId, reviewer: ADMIN, now: 60 })).toEqual({ liveUrl: `https://${s.slug}.asksite.example/`, missingPhotos: 0 });
    const work = await (await env.WORK.get(versionKey(s.siteId, s.liveVersionId)))?.text();
    expect(await (await env.LIVE.get(liveKey(s.slug)))?.text()).toBe(work);
    expect(await siteRow(env.DB, s.siteId)).toMatchObject({ taken_down_at: null, takedown_reason: null });
    expect((await auditActions(env.DB, s.siteId)).slice(-2)).toEqual(["site.taken_down", "site.restored"]);
  });

  it("is retry-safe and audits once", async () => {
    const s = await liveSite();
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "x", purgeMedia: false, now: 50 });
    await restore(env, { siteId: s.siteId, reviewer: ADMIN, now: 60 });
    await restore(env, { siteId: s.siteId, reviewer: ADMIN, now: 61 });
    expect((await auditActions(env.DB, s.siteId)).filter((a) => a === "site.restored")).toHaveLength(1);
  });

  it("refuses a site that was never live", async () => {
    const site = await seedSite(env.DB);
    expect((await failure(restore(env, { siteId: site.siteId, reviewer: ADMIN, now: 1 }))).code).toBe("not_live");
  });

  it("counts the photos a purge deleted, so the admin knows the page will show broken images", async () => {
    const site = await seedSite(env.DB);
    const photos = [await addUpload(site.siteId), await addUpload(site.siteId)].map((id) => ({ url: mediaUrl(ROOT, site.siteId, id), alt: "A finished job", width: 1600, height: 1200 }));
    const base = doc("plumber-austin");
    const document = SiteDocument.parse({ ...base, facts: { ...base.facts, heroPhoto: photos[0], photos: [photos[1]] } });
    const v1 = await createPendingVersion(env, { ...site, document, edits: EDITS, generationId: null, now: 1 });
    await approveVersion(env, { versionId: v1.id, htmlSha256: String((await versionRow(env.DB, v1.id))?.html_sha256), reviewer: ADMIN, note: null, indexable: true, now: 2 });
    await takeDown(env, { siteId: site.siteId, reviewer: ADMIN, reason: "Abuse", purgeMedia: true, now: 3 });
    expect(await restore(env, { siteId: site.siteId, reviewer: ADMIN, now: 4 })).toEqual({ liveUrl: `https://${site.slug}.asksite.example/`, missingPhotos: 2 });
    expect((await siteRow(env.DB, site.siteId))?.taken_down_at).toBeNull();
  });

  it("refuses when the stored bytes no longer match, and leaves the site taken down", async () => {
    const s = await liveSite();
    await takeDown(env, { siteId: s.siteId, reviewer: ADMIN, reason: "x", purgeMedia: false, now: 50 });
    await env.WORK.put(versionKey(s.siteId, s.liveVersionId), "tampered");
    expect((await failure(restore(env, { siteId: s.siteId, reviewer: ADMIN, now: 60 }))).code).toBe("integrity");
    expect((await siteRow(env.DB, s.siteId))?.taken_down_at).toBe(50);
    expect(await env.LIVE.get(liveKey(s.slug))).toBeNull();
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
