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
    // A15: the business phone of the approved document (plumber-austin: +15125550142), for the sites
    // Worker's "Please call instead" page: the text the page shows and the number its tel: links call.
    // QA-2 RU(2): and its business name, for the thank-you and 404 pages.
    expect(live?.customMetadata).toEqual({
      siteId: p.siteId, versionId: p.versionId, sha256: p.htmlSha256, businessName: "Reliable Rooter Plumbing", phoneText: "(512) 555-0142", phoneTel: "+15125550142",
    });
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
    // The name and phone follow the live document too (hvac-phoenix: +16025550118).
    expect((await env.LIVE.get(liveKey(p.slug)))?.customMetadata).toMatchObject({
      versionId: second.id, businessName: "Desert Air Heating & Cooling", phoneText: "(602) 555-0118", phoneTel: "+16025550118",
    });
    expect((await versionRow(env.DB, p.versionId))?.status).toBe("approved");
  });
});

// QA-2 RU(2): the name goes into the metadata exactly as the page shows it; the sites Worker escapes it.
// The R2 Workers API takes Unicode metadata values as they are (developers.cloudflare.com/r2/api/s3/extensions/).
describe("approveVersion: the business name in the LIVE metadata", () => {
  it.each([
    ["accents, an emoji and markup characters", `Café Niño 🔧 <b>"Sons"</b> & Co.`],
    ["the XSS fixture's name", "<img src=x onerror=alert(1)>"],
  ])("stores a name with %s unchanged", async (_, businessName) => {
    const document = doc();
    document.facts.businessName = businessName;
    const p = await pending(document);
    await approve(p.versionId, p.htmlSha256);
    expect((await env.LIVE.head(liveKey(p.slug)))?.customMetadata?.["businessName"]).toBe(businessName);
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

describe("what the review actions record and refuse (design §7.2)", () => {
  const auditRows = async (siteId: string) =>
    (await env.DB.prepare("SELECT at, actor, action, detail_json FROM audit_log WHERE site_id = ? ORDER BY id").bind(siteId).all<{ detail_json: string }>())
      .results.map((row) => ({ ...row, detail_json: JSON.parse(row.detail_json) as unknown }));
  const updatedAt = (siteId: string) => env.DB.prepare("SELECT updated_at FROM sites WHERE id = ?").bind(siteId).first("updated_at");

  it("an approval is logged as the admin's, with the version and the search setting, and stamps the site", async () => {
    const p = await pending();
    await approve(p.versionId, p.htmlSha256, { indexable: false });
    expect((await auditRows(p.siteId))[1]).toEqual({ at: 20, actor: "admin:admin@example.com", action: "version.approved", detail_json: { versionId: p.versionId, indexable: false } });
    expect(await updatedAt(p.siteId)).toBe(20);
  });

  it("a rejection is logged as the admin's, with the version, and stamps the site", async () => {
    const p = await pending();
    await rejectVersion(env, { versionId: p.versionId, reviewer: "admin@example.com", note: "No", now: 11 });
    expect((await auditRows(p.siteId))[1]).toEqual({ at: 11, actor: "admin:admin@example.com", action: "version.rejected", detail_json: { versionId: p.versionId } });
    expect(await updatedAt(p.siteId)).toBe(11);
  });

  it("names why the bytes were refused (a missing page too), and changes nothing", async () => {
    const seen = await pending();
    const tampered = await pending();
    await env.WORK.put(versionKey(tampered.siteId, tampered.versionId), "<!DOCTYPE html><p>tampered</p>");
    const missing = await pending();
    await env.WORK.delete(versionKey(missing.siteId, missing.versionId));
    const refused = async (p: Awaited<ReturnType<typeof pending>>, sha: string) => {
      const error = await failure(approve(p.versionId, sha));
      return { code: error.code, detail: error.detail };
    };
    expect(await refused(seen, "0".repeat(64))).toEqual({ code: "integrity", detail: { reason: "reviewed_hash_mismatch" } });
    expect(await refused(tampered, tampered.htmlSha256)).toEqual({ code: "integrity", detail: { reason: "stored_bytes_mismatch" } });
    expect(await refused(missing, missing.htmlSha256)).toEqual({ code: "integrity", detail: { reason: "stored_bytes_mismatch" } });
    for (const p of [seen, tampered, missing]) {
      expect(await versionRow(env.DB, p.versionId)).toMatchObject({ status: "pending", reviewed_by: null });
      expect(await siteRow(env.DB, p.siteId)).toMatchObject({ live_version_id: null, pending_version_id: p.versionId });
      expect(await auditActions(env.DB, p.siteId)).toEqual(["version.requested"]);
      expect(await env.LIVE.get(liveKey(p.slug))).toBeNull();
    }
  });

  it("a retry after the site was taken down does not put the page back", async () => {
    const p = await pending();
    await approve(p.versionId, p.htmlSha256);
    await env.DB.prepare("UPDATE sites SET taken_down_at = 25 WHERE id = ?").bind(p.siteId).run();
    await env.LIVE.delete(liveKey(p.slug)); // a takedown deletes the live page too (Task 10)
    expect((await failure(approve(p.versionId, p.htmlSha256, { now: 30 }))).code).toBe("site_taken_down");
    expect(await env.LIVE.get(liveKey(p.slug))).toBeNull();
    expect(await auditActions(env.DB, p.siteId)).toEqual(["version.requested", "version.approved"]);
  });

  it("rejecting a superseded version leaves the newer version in review", async () => {
    const p = await pending();
    const newer = await createPendingVersion(env, { siteId: p.siteId, ownerId: p.ownerId, slug: p.slug, document: doc(), edits: EDITS, generationId: null, now: 12 });
    expect((await failure(rejectVersion(env, { versionId: p.versionId, reviewer: "admin@example.com", note: "No", now: 13 }))).code).toBe("version_not_pending");
    expect((await siteRow(env.DB, p.siteId))?.pending_version_id).toBe(newer.id);
    expect((await versionRow(env.DB, newer.id))?.status).toBe("pending");
    expect((await versionRow(env.DB, p.versionId))?.status).toBe("superseded");
    expect(await auditActions(env.DB, p.siteId)).toEqual(["version.requested", "version.requested"]);
  });
});
