import { livePageKey, livePointerKey, liveSitePrefix, newId, sha256Hex, versionKey, versionPageKey } from "@asksite/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { approveVersion, createPendingVersion, rejectVersion, takeDown } from "../src/index.ts";
import { publishFailure as failure } from "./support/errors.ts";
import { auditActions, doc, EDITS, flakyBucket, liveKeysOf, pendingWithPages, publishingHarness, seedSite, siteRow, versionRow, type PublishEnv } from "./support/harness.ts";

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
  // html_sha256 is the digest of the pages (what the admin approves); homeSha256 is Home's own hash.
  const home = JSON.parse(String(row?.pages_json)) as Array<{ page: string; sha256: string }>;
  return { ...site, versionId: version.id, htmlSha256: String(row?.html_sha256), homeSha256: String(home[0]?.sha256) };
}

const approve = (versionId: string, htmlSha256: string, extra: Partial<{ indexable: boolean; note: string | null; now: number }> = {}) =>
  approveVersion(env, { versionId, htmlSha256, reviewer: "admin@example.com", note: null, indexable: true, now: 20, ...extra });

describe("approveVersion", () => {
  it("makes the reviewed bytes live and records who approved them", async () => {
    const p = await pending();
    const result = await approve(p.versionId, p.htmlSha256, { note: "Looks good", indexable: false });
    expect(result).toEqual({ siteId: p.siteId, slug: p.slug, liveUrl: `https://${p.slug}.asksite.example/` });

    const work = await (await env.WORK.get(versionKey(p.siteId, p.versionId)))?.text();
    const live = await env.LIVE.get(livePageKey(p.slug, p.versionId, "home"));
    expect(await live?.text()).toBe(work);
    expect(live?.httpMetadata?.contentType).toBe("text/html; charset=utf-8");
    expect(live?.customMetadata).toEqual({ siteId: p.siteId, versionId: p.versionId, page: "home", sha256: p.homeSha256 });
    // The pointer: an empty object that names the live version. A15: the business phone of the approved document
    // (plumber-austin: +15125550142), for the sites Worker's "Please call instead" page: the text the page shows and
    // the number its tel: links call. QA-2 RU(2): and its business name, for the thank-you and 404 pages.
    const pointer = await env.LIVE.get(livePointerKey(p.slug));
    expect(await pointer?.text()).toBe("");
    expect(pointer?.customMetadata).toEqual({
      siteId: p.siteId, versionId: p.versionId, businessName: "Reliable Rooter Plumbing", phoneText: "(512) 555-0142", phoneTel: "+15125550142",
    });
    expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([livePointerKey(p.slug), livePageKey(p.slug, p.versionId, "home")].sort());
    expect(await sha256Hex(String(work))).toBe(p.homeSha256);

    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ live_version_id: p.versionId, pending_version_id: null, indexable: 0 });
    expect(await versionRow(env.DB, p.versionId)).toMatchObject({ status: "approved", reviewed_by: "admin@example.com", reviewed_at: 20, review_note: "Looks good" });
    expect(await auditActions(env.DB, p.siteId)).toEqual(["version.requested", "version.approved"]);
  });

  it("refuses when the admin saw different bytes, and changes nothing", async () => {
    const p = await pending();
    const error = await failure(approve(p.versionId, "0".repeat(64)));
    expect(error.code).toBe("integrity");
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ live_version_id: null, pending_version_id: p.versionId });
    expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([]);
  });

  it("refuses when the stored bytes were changed after review", async () => {
    const p = await pending();
    await env.WORK.put(versionKey(p.siteId, p.versionId), "<!DOCTYPE html><p>tampered</p>");
    expect((await failure(approve(p.versionId, p.htmlSha256))).code).toBe("integrity");
    expect((await siteRow(env.DB, p.siteId))?.live_version_id).toBeNull();
  });

  it("is idempotent: a retry after a failed pointer write finishes the job without a second audit row", async () => {
    const p = await pending();
    await approve(p.versionId, p.htmlSha256);
    await env.LIVE.delete(livePointerKey(p.slug)); // as if the pointer write had failed
    await approve(p.versionId, p.htmlSha256, { now: 30 });
    expect(await env.LIVE.get(livePointerKey(p.slug))).not.toBeNull();
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
    expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([]); // nothing was copied for a version that will be refused
  });

  it("never lets an older approved version overwrite the newer live page", async () => {
    const p = await pending();
    await approve(p.versionId, p.htmlSha256);
    const second = await createPendingVersion(env, { siteId: p.siteId, ownerId: p.ownerId, slug: p.slug, document: doc("hvac-phoenix"), edits: EDITS, generationId: null, now: 40 });
    const secondSha = String((await versionRow(env.DB, second.id))?.html_sha256);
    await approve(second.id, secondSha, { now: 41 });
    expect((await failure(approve(p.versionId, p.htmlSha256, { now: 42 }))).code).toBe("version_not_pending");
    // The name and phone follow the live document too (hvac-phoenix: +16025550118).
    expect((await env.LIVE.get(livePointerKey(p.slug)))?.customMetadata).toMatchObject({
      versionId: second.id, businessName: "Desert Air Heating & Cooling", phoneText: "(602) 555-0118", phoneTel: "+16025550118",
    });
    expect((await versionRow(env.DB, p.versionId))?.status).toBe("approved");
    // The older version's pages never came back, and the replaced one's are gone.
    expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([livePointerKey(p.slug), livePageKey(p.slug, second.id, "home")].sort());
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
    expect((await env.LIVE.head(livePointerKey(p.slug)))?.customMetadata?.["businessName"]).toBe(businessName);
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
      expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([]);
    }
  });

  it("a retry after the site was taken down does not put the pages back", async () => {
    const p = await pending();
    await approve(p.versionId, p.htmlSha256);
    await env.DB.prepare("UPDATE sites SET taken_down_at = 25 WHERE id = ?").bind(p.siteId).run();
    await env.LIVE.delete(livePointerKey(p.slug)); // a takedown deletes the pointer and the live pages too
    await env.LIVE.delete(livePageKey(p.slug, p.versionId, "home"));
    expect((await failure(approve(p.versionId, p.htmlSha256, { now: 30 }))).code).toBe("site_taken_down");
    expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([]);
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

// A16 + U2: every page of the approved version is copied to its own immutable LIVE key, and only then does one
// pointer write switch the whole site. The renderer gives one page for now, so these versions are built by hand.
describe("approveVersion: all the pages, then the pointer (A16)", () => {
  const WORK_PAGES = async (p: Awaited<ReturnType<typeof pendingWithPages>>) =>
    Promise.all(p.pages.map(async (page) => ({ page: page.page, html: page.html, live: await (await env.LIVE.get(livePageKey(p.slug, p.versionId, page.page)))?.text() })));

  it("copies every page to its immutable key with the page's own hash, then writes the pointer", async () => {
    const p = await pendingWithPages(env, ["home", "services", "about", "contact"]);
    const calls: Array<{ call: string; arg: unknown }> = [];
    await approveVersion({ ...env, LIVE: flakyBucket(env.LIVE, () => false, calls) }, { versionId: p.versionId, htmlSha256: p.htmlSha256, reviewer: "admin@example.com", note: null, indexable: true, now: 20 });
    const order = calls.filter((c) => c.call === "put").map((c) => String(c.arg));

    for (const page of await WORK_PAGES(p)) expect(page.live).toBe(page.html);
    for (const page of p.pages) {
      const live = await env.LIVE.head(livePageKey(p.slug, p.versionId, page.page));
      expect(live?.customMetadata).toEqual({ siteId: p.siteId, versionId: p.versionId, page: page.page, sha256: page.sha256 });
      expect(live?.httpMetadata?.contentType).toBe("text/html; charset=utf-8");
    }
    expect(order.at(-1)).toBe(livePointerKey(p.slug)); // the one write that switches the site comes last
    expect(order.filter((key) => key === livePointerKey(p.slug))).toHaveLength(1);
    expect(order.slice(0, -1).sort()).toEqual(p.pages.map((page) => livePageKey(p.slug, p.versionId, page.page)).sort());
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ live_version_id: p.versionId, pending_version_id: null });
  });

  it("removes the replaced version's pages after the switch, and only that site's", async () => {
    const first = await pendingWithPages(env);
    const neighbour = await pendingWithPages(env, ["home", "services"], `${first.slug}s`); // its slug starts with the first site's
    await approve(neighbour.versionId, neighbour.htmlSha256);
    await approve(first.versionId, first.htmlSha256);
    const second = await createPendingVersion(env, { siteId: first.siteId, ownerId: first.ownerId, slug: first.slug, document: doc(), edits: EDITS, generationId: null, now: 30 });
    await approve(second.id, String((await versionRow(env.DB, second.id))?.html_sha256), { now: 31 });
    expect(await liveKeysOf(env.LIVE, first.slug)).toEqual([livePointerKey(first.slug), livePageKey(first.slug, second.id, "home")].sort());
    expect(await liveKeysOf(env.LIVE, neighbour.slug)).toEqual([livePointerKey(neighbour.slug), ...neighbour.pages.map((page) => livePageKey(neighbour.slug, neighbour.versionId, page.page))].sort());
  });

  it("removes the replaced version's pages only after the pointer write", async () => {
    const first = await pendingWithPages(env, ["home", "services", "about", "contact"]);
    await approve(first.versionId, first.htmlSha256);
    const second = await createPendingVersion(env, { siteId: first.siteId, ownerId: first.ownerId, slug: first.slug, document: doc(), edits: EDITS, generationId: null, now: 30 });
    const calls: Array<{ call: string; arg: unknown }> = [];
    await approveVersion({ ...env, LIVE: flakyBucket(env.LIVE, () => false, calls) }, { versionId: second.id, htmlSha256: String((await versionRow(env.DB, second.id))?.html_sha256), reviewer: "admin@example.com", note: null, indexable: true, now: 31 });
    const pointerPut = calls.findIndex((c) => c.call === "put" && c.arg === livePointerKey(first.slug));
    const deletes = calls.flatMap((c, i) => (c.call === "delete" ? [i] : []));
    expect(pointerPut).toBeGreaterThan(-1);
    expect(deletes.length).toBeGreaterThan(0);
    expect(deletes.every((i) => i > pointerPut)).toBe(true);
  });

  it("answers live_copy_failed when only the pointer write fails, and approving again heals it with one audit row", async () => {
    const p = await pendingWithPages(env);
    const v1 = await pendingWithPages(env, ["home", "services", "about", "contact"]);
    await approve(v1.versionId, v1.htmlSha256);
    const v2 = await createPendingVersion(env, { siteId: v1.siteId, ownerId: v1.ownerId, slug: v1.slug, document: doc(), edits: EDITS, generationId: null, now: 30 });
    const v2Sha = String((await versionRow(env.DB, v2.id))?.html_sha256);
    const v1Keys = await liveKeysOf(env.LIVE, v1.slug);
    const v2PointerFails = flakyBucket(env.LIVE, (call, key) => call === "put" && key === livePointerKey(v1.slug));
    expect((await failure(approveVersion({ ...env, LIVE: v2PointerFails }, { versionId: v2.id, htmlSha256: v2Sha, reviewer: "admin@example.com", note: null, indexable: true, now: 31 }))).code).toBe("live_copy_failed");
    // The pointer still names v1 and all of v1's pages are still there, so the site keeps being served until the retry.
    expect((await env.LIVE.head(livePointerKey(v1.slug)))?.customMetadata?.["versionId"]).toBe(v1.versionId);
    expect(await liveKeysOf(env.LIVE, v1.slug)).toEqual([...v1Keys, livePageKey(v1.slug, v2.id, "home")].sort());

    const pointerFails = flakyBucket(env.LIVE, (call, key) => call === "put" && key === livePointerKey(p.slug));
    const error = await failure(approveVersion({ ...env, LIVE: pointerFails }, { versionId: p.versionId, htmlSha256: p.htmlSha256, reviewer: "admin@example.com", note: null, indexable: true, now: 20 }));
    expect({ code: error.code, detail: error.detail }).toEqual({ code: "live_copy_failed", detail: { versionId: p.versionId } });
    // D1 committed, the pages are copied, but nothing is served: there is no pointer.
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ live_version_id: p.versionId, pending_version_id: null });
    expect(await env.LIVE.head(livePointerKey(p.slug))).toBeNull();

    await approve(p.versionId, p.htmlSha256, { now: 30 });
    expect((await env.LIVE.head(livePointerKey(p.slug)))?.customMetadata?.["versionId"]).toBe(p.versionId);
    expect((await auditActions(env.DB, p.siteId)).filter((a) => a === "version.approved")).toHaveLength(1);
    expect((await versionRow(env.DB, p.versionId))?.reviewed_at).toBe(20);
  });

  // Residual 1 (moderator, 2026-10-01; strict: exposure). An approve and another admin's takedown can interleave, and
  // the pointer must never stay on a taken-down site: it would put the business name and phone back on the site's
  // 404, thank-you and "please call" pages. Both orders are tested, for a first approval and for an accepted retry:
  // (a) the whole takedown commits between this approve's D1 batch and its pointer write (the seam runs the real
  // takeDown inside the pointer write): approve takes its pointer back out;
  // (b) this whole approve runs between the takedown's first pointer delete and its D1 batch (the seam runs the
  // real approveVersion inside that delete): the takedown deletes the pointer again after its D1 batch.
  const RACES = [
    ["a first approval", false],
    ["an accepted retry", true],
  ] as const;

  it.each(RACES)("takes its pointer back out when a takedown commits before its pointer write (%s)", async (_name, approvedBefore) => {
    const p = await pendingWithPages(env);
    if (approvedBefore) await approve(p.versionId, p.htmlSha256);
    const racingTakedown = {
      ...flakyBucket(env.LIVE, () => false),
      put: async (...args: Parameters<R2Bucket["put"]>) => {
        if (args[0] === livePointerKey(p.slug)) await takeDown(env, { siteId: p.siteId, reviewer: "other@example.com", reason: "Phishing", purgeMedia: false, now: 40 });
        return env.LIVE.put(...args);
      },
    } as R2Bucket;
    const racing = approveVersion({ ...env, LIVE: racingTakedown }, { versionId: p.versionId, htmlSha256: p.htmlSha256, reviewer: "admin@example.com", note: null, indexable: true, now: 41 });
    expect((await failure(racing)).code).toBe("site_taken_down");
    expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([]);
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: 40 });
  });

  it.each(RACES)("leaves no pointer when the whole approve runs inside a takedown, before its D1 batch (%s)", async (_name, approvedBefore) => {
    const p = await pendingWithPages(env);
    if (approvedBefore) await approve(p.versionId, p.htmlSha256);
    let raced = false;
    const racingApprove = {
      ...flakyBucket(env.LIVE, () => false),
      delete: async (keys: string | string[]) => {
        await env.LIVE.delete(keys);
        if (keys === livePointerKey(p.slug) && !raced) {
          raced = true;
          await approveVersion(env, { versionId: p.versionId, htmlSha256: p.htmlSha256, reviewer: "admin@example.com", note: null, indexable: true, now: 39 });
        }
      },
    } as R2Bucket;
    await takeDown({ ...env, LIVE: racingApprove }, { siteId: p.siteId, reviewer: "other@example.com", reason: "Phishing", purgeMedia: false, now: 40 });
    expect(raced).toBe(true);
    expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([]);
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: 40 });
  });

  it("logs and refuses when it cannot take its pointer back out, and the takedown's retry removes it", async () => {
    const p = await pendingWithPages(env);
    const pointerDeleteFails = {
      ...flakyBucket(env.LIVE, (call, key) => call === "delete" && key === livePointerKey(p.slug)),
      put: async (...args: Parameters<R2Bucket["put"]>) => {
        if (args[0] === livePointerKey(p.slug)) await takeDown(env, { siteId: p.siteId, reviewer: "other@example.com", reason: "Phishing", purgeMedia: false, now: 40 });
        return env.LIVE.put(...args);
      },
    } as R2Bucket;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const racing = approveVersion({ ...env, LIVE: pointerDeleteFails }, { versionId: p.versionId, htmlSha256: p.htmlSha256, reviewer: "admin@example.com", note: null, indexable: true, now: 41 });
      expect((await failure(racing)).code).toBe("site_taken_down");
      expect(logged.mock.calls.map((c) => String(c[0]))).toContainEqual(JSON.stringify({ code: "takedown_pointer_left", siteId: p.siteId, versionId: p.versionId }));
    } finally {
      logged.mockRestore();
    }
    expect(await env.LIVE.head(livePointerKey(p.slug))).not.toBeNull(); // left behind: ops see the log line
    await takeDown(env, { siteId: p.siteId, reviewer: "other@example.com", reason: "Phishing", purgeMedia: false, now: 42 });
    expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([]);
  });

  it("changes neither D1 nor the pointer when a page copy fails, and can be retried", async () => {
    const p = await pendingWithPages(env);
    const servicesFails = flakyBucket(env.LIVE, (call, key) => call === "put" && key === livePageKey(p.slug, p.versionId, "services"));
    await expect(approveVersion({ ...env, LIVE: servicesFails }, { versionId: p.versionId, htmlSha256: p.htmlSha256, reviewer: "admin@example.com", note: null, indexable: true, now: 20 })).rejects.toThrow("R2 is unavailable");
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ live_version_id: null, pending_version_id: p.versionId });
    expect(await versionRow(env.DB, p.versionId)).toMatchObject({ status: "pending", reviewed_by: null });
    expect(await auditActions(env.DB, p.siteId)).toEqual(["version.requested"]);
    expect(await env.LIVE.head(livePointerKey(p.slug))).toBeNull();

    await approve(p.versionId, p.htmlSha256);
    expect(await liveKeysOf(env.LIVE, p.slug)).toHaveLength(1 + 3);
    expect(await auditActions(env.DB, p.siteId)).toEqual(["version.requested", "version.approved"]);
  });

  it("an old version's pages that cannot be removed never fail the approval and are logged without text", async () => {
    const p = await pendingWithPages(env);
    const cleanupFails = flakyBucket(env.LIVE, (call) => call === "list");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await approveVersion({ ...env, LIVE: cleanupFails }, { versionId: p.versionId, htmlSha256: p.htmlSha256, reviewer: "admin@example.com", note: null, indexable: true, now: 20 });
      expect(logged).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toEqual({ code: "live_cleanup_failed", siteId: p.siteId, versionId: p.versionId });
    } finally {
      logged.mockRestore();
    }
    expect((await env.LIVE.head(livePointerKey(p.slug)))?.customMetadata?.["versionId"]).toBe(p.versionId);
  });

  it("deletes in calls of at most 1,000 keys, across every listing page", async () => {
    const p = await pendingWithPages(env);
    const stale = Array.from({ length: 1001 }, (_, i) => `${liveSitePrefix(p.slug)}${newId()}/home.html`);
    for (let i = 0; i < stale.length; i += 100) await Promise.all(stale.slice(i, i + 100).map((key) => env.LIVE.put(key, "old")));
    const calls: Array<{ call: string; arg: unknown }> = [];
    await approveVersion({ ...env, LIVE: flakyBucket(env.LIVE, () => false, calls) }, { versionId: p.versionId, htmlSha256: p.htmlSha256, reviewer: "admin@example.com", note: null, indexable: true, now: 20 });
    const deleted = calls.filter((c) => c.call === "delete").map((c) => c.arg as string[]);
    expect(deleted.every((keys) => keys.length <= 1000)).toBe(true);
    expect(deleted.flat()).toHaveLength(1001);
    expect(await liveKeysOf(env.LIVE, p.slug)).toHaveLength(1 + 3);
  }, 60_000);
});


describe("approveVersion refuses a damaged version and changes nothing (A16)", () => {
  type Built = Awaited<ReturnType<typeof pendingWithPages>>;
  const damages: Array<{ name: string; reason: string; damage: (p: Built) => Promise<unknown>; reviewed?: (p: Built) => string }> = [
    { name: "a tampered page", reason: "stored_bytes_mismatch", damage: (p) => env.WORK.put(versionPageKey(p.siteId, p.versionId, "services"), "<p>tampered</p>") },
    { name: "a missing page", reason: "stored_bytes_mismatch", damage: (p) => env.WORK.delete(versionPageKey(p.siteId, p.versionId, "contact")) },
    {
      name: "a changed sha in pages_json",
      reason: "pages_digest_mismatch",
      damage: (p) => {
        const pages = p.pages.map(({ page, sha256 }) => ({ page, sha256: page === "services" ? "0".repeat(64) : sha256 }));
        return env.DB.prepare("UPDATE site_versions SET pages_json = ? WHERE id = ?").bind(JSON.stringify(pages), p.versionId).run();
      },
    },
    { name: "pages_json '[]'", reason: "pages_invalid", damage: (p) => env.DB.prepare("UPDATE site_versions SET pages_json = '[]' WHERE id = ?").bind(p.versionId).run() },
    { name: "pages_json that is not JSON", reason: "pages_invalid", damage: (p) => env.DB.prepare("UPDATE site_versions SET pages_json = '{not json' WHERE id = ?").bind(p.versionId).run() },
    {
      name: "Home not first",
      reason: "pages_invalid",
      damage: (p) => env.DB.prepare("UPDATE site_versions SET pages_json = ? WHERE id = ?").bind(JSON.stringify(p.pages.map(({ page, sha256 }) => ({ page, sha256 })).reverse()), p.versionId).run(),
    },
    {
      name: "an html_key that is not Home's key",
      reason: "pages_invalid",
      damage: (p) => env.DB.prepare("UPDATE site_versions SET html_key = ? WHERE id = ?").bind(versionPageKey(p.siteId, p.versionId, "services"), p.versionId).run(),
    },
    { name: "a reviewed hash that is not the digest", reason: "reviewed_hash_mismatch", damage: async () => {}, reviewed: (p) => p.pages[0]?.sha256 ?? "" },
  ];

  it.each(damages)("$name", async ({ reason, damage, reviewed }) => {
    const p = await pendingWithPages(env);
    await damage(p);
    const error = await failure(approve(p.versionId, reviewed?.(p) ?? p.htmlSha256));
    expect({ code: error.code, detail: error.detail }).toEqual({ code: "integrity", detail: { reason } });
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ live_version_id: null, pending_version_id: p.versionId });
    expect(await versionRow(env.DB, p.versionId)).toMatchObject({ status: "pending", reviewed_by: null });
    expect(await auditActions(env.DB, p.siteId)).toEqual(["version.requested"]);
    expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([]); // no page and no pointer
  });

  it("copies nothing to LIVE for a version that is not pending", async () => {
    const rejected = await pendingWithPages(env);
    await rejectVersion(env, { versionId: rejected.versionId, reviewer: "admin@example.com", note: "No", now: 11 });
    const superseded = await pendingWithPages(env);
    await createPendingVersion(env, { siteId: superseded.siteId, ownerId: superseded.ownerId, slug: superseded.slug, document: doc(), edits: EDITS, generationId: null, now: 12 });
    for (const p of [rejected, superseded]) {
      expect((await failure(approve(p.versionId, p.htmlSha256))).code).toBe("version_not_pending");
      expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([]);
    }
  });
});
