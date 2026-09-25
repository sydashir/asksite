import { liveKey, sha256Hex, versionKey } from "@asksite/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveVersion, createPendingVersion, rejectVersion } from "../src/index.ts";
import { publishFailure as failure } from "./support/errors.ts";
import { auditActions, doc, EDITS, publishingHarness, seedSite, siteRow, versionRow, type PublishEnv } from "./support/harness.ts";

const harness = publishingHarness("publishing-review-test");
let env: PublishEnv;
beforeAll(async () => {
  env = await harness.start();
}, 120_000);
afterAll(async () => {
  await harness.server.close();
});

/** A site with one version in review; returns what the admin was shown. */
async function pending(document = doc()) {
  const site = await seedSite(env.DB);
  const version = await createPendingVersion(env, { ...site, document, edits: EDITS, generationId: null, now: 10 });
  const row = await versionRow(env.DB, version.id);
  return { ...site, versionId: version.id, htmlSha256: String(row?.html_sha256) };
}

const approve = (versionId: string, htmlSha256: string, extra: Partial<{ indexable: boolean; note: string | null; now: number }> = {}) =>
  approveVersion(env, { versionId, htmlSha256, reviewer: "admin@example.com", note: null, indexable: true, now: 20, ...extra });

describe("approveVersion", () => {
  it("makes the reviewed bytes live and records who approved them", async () => {
    const p = await pending();
    const result = await approve(p.versionId, p.htmlSha256, { note: "Looks good", indexable: false });
    expect(result).toEqual({ siteId: p.siteId, slug: p.slug, liveUrl: `https://${p.slug}.asksite.example/` });

    const work = await (await env.WORK.get(versionKey(p.siteId, p.versionId)))?.text();
    const live = await env.LIVE.get(liveKey(p.slug));
    expect(await live?.text()).toBe(work);
    expect(live?.httpMetadata?.contentType).toBe("text/html; charset=utf-8");
    expect(live?.customMetadata).toEqual({ siteId: p.siteId, versionId: p.versionId, sha256: p.htmlSha256 });
    expect(await sha256Hex(String(work))).toBe(p.htmlSha256);

    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ live_version_id: p.versionId, pending_version_id: null, indexable: 0 });
    expect(await versionRow(env.DB, p.versionId)).toMatchObject({ status: "approved", reviewed_by: "admin@example.com", reviewed_at: 20, review_note: "Looks good" });
    expect(await auditActions(env.DB, p.siteId)).toEqual(["version.requested", "version.approved"]);
  });

  it("refuses when the admin saw different bytes, and changes nothing", async () => {
    const p = await pending();
    const error = await failure(approve(p.versionId, "0".repeat(64)));
    expect(error.code).toBe("integrity");
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ live_version_id: null, pending_version_id: p.versionId });
    expect(await env.LIVE.get(liveKey(p.slug))).toBeNull();
  });

  it("refuses when the stored bytes were changed after review", async () => {
    const p = await pending();
    await env.WORK.put(versionKey(p.siteId, p.versionId), "<!DOCTYPE html><p>tampered</p>");
    expect((await failure(approve(p.versionId, p.htmlSha256))).code).toBe("integrity");
    expect((await siteRow(env.DB, p.siteId))?.live_version_id).toBeNull();
  });

  it("is idempotent: a retry after a failed LIVE write finishes the job without a second audit row", async () => {
    const p = await pending();
    await approve(p.versionId, p.htmlSha256);
    await env.LIVE.delete(liveKey(p.slug)); // as if step 3 had failed
    await approve(p.versionId, p.htmlSha256, { now: 30 });
    expect(await env.LIVE.get(liveKey(p.slug))).not.toBeNull();
    expect(await auditActions(env.DB, p.siteId)).toEqual(["version.requested", "version.approved"]);
    expect((await versionRow(env.DB, p.versionId))?.reviewed_at).toBe(20);
  });

  it("refuses a rejected, superseded or unknown version", async () => {
    const rejected = await pending();
    await rejectVersion(env, { versionId: rejected.versionId, reviewer: "admin@example.com", note: "No", now: 11 });
    expect((await failure(approve(rejected.versionId, rejected.htmlSha256))).code).toBe("version_not_pending");

    const superseded = await pending();
    await createPendingVersion(env, { siteId: superseded.siteId, ownerId: superseded.ownerId, slug: superseded.slug, document: doc(), edits: EDITS, generationId: null, now: 12 });
    expect((await failure(approve(superseded.versionId, superseded.htmlSha256))).code).toBe("version_not_pending");

    expect((await failure(approve("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "0".repeat(64)))).code).toBe("version_not_pending");
  });

  it("refuses a site that was taken down while in review", async () => {
    const p = await pending();
    await env.DB.prepare("UPDATE sites SET taken_down_at = 15 WHERE id = ?").bind(p.siteId).run();
    expect((await failure(approve(p.versionId, p.htmlSha256))).code).toBe("site_taken_down");
    expect(await env.LIVE.get(liveKey(p.slug))).toBeNull();
  });

  it("never lets an older approved version overwrite the newer live page", async () => {
    const p = await pending();
    await approve(p.versionId, p.htmlSha256);
    const second = await createPendingVersion(env, { siteId: p.siteId, ownerId: p.ownerId, slug: p.slug, document: doc("hvac-phoenix"), edits: EDITS, generationId: null, now: 40 });
    const secondSha = String((await versionRow(env.DB, second.id))?.html_sha256);
    await approve(second.id, secondSha, { now: 41 });
    expect((await failure(approve(p.versionId, p.htmlSha256, { now: 42 }))).code).toBe("version_not_pending");
    expect((await env.LIVE.get(liveKey(p.slug)))?.customMetadata?.["versionId"]).toBe(second.id);
    expect((await versionRow(env.DB, p.versionId))?.status).toBe("approved");
  });
});

describe("rejectVersion", () => {
  it("rejects with the note and clears the review", async () => {
    const p = await pending();
    expect(await rejectVersion(env, { versionId: p.versionId, reviewer: "admin@example.com", note: "Remove the phone number from the caption", now: 11 })).toEqual({ siteId: p.siteId });
    expect(await versionRow(env.DB, p.versionId)).toMatchObject({ status: "rejected", reviewed_by: "admin@example.com", reviewed_at: 11, review_note: "Remove the phone number from the caption" });
    expect((await siteRow(env.DB, p.siteId))?.pending_version_id).toBeNull();
    expect(await auditActions(env.DB, p.siteId)).toEqual(["version.requested", "version.rejected"]);
  });

  it("refuses a version that is not in review, without a second audit row", async () => {
    const p = await pending();
    await rejectVersion(env, { versionId: p.versionId, reviewer: "admin@example.com", note: "No", now: 11 });
    expect((await failure(rejectVersion(env, { versionId: p.versionId, reviewer: "admin@example.com", note: "No", now: 12 }))).code).toBe("version_not_pending");
    expect((await failure(rejectVersion(env, { versionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", reviewer: "a", note: "n", now: 1 }))).code).toBe("version_not_pending");
    expect(await auditActions(env.DB, p.siteId)).toEqual(["version.requested", "version.rejected"]);
  });
});
