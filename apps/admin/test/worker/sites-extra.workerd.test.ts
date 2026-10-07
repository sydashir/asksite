import { livePageKey, livePointerKey, newId, versionPageKey } from "@asksite/core";
import { PAGE_IDS } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { LEASE_LOST, RESTORE_LIVE_COPY_FAILED, TAKEDOWN_LEASE_LOST } from "../../src/messages.ts";
import { GENERATION_HISTORY, SITE_AUDIT, SITE_LAST_RESTORED, SITE_LIST, VERSION_HISTORY } from "../../src/worker/queries.ts";
import { accessToken, json, useAdminHarness } from "../support/harness.ts";

const h = useAdminHarness();

/** How many promises a request to `path` hands to waitUntil, and its status. */
async function handedOver(method: string, path: string, body?: unknown): Promise<{ status: number; waitUntil: number }> {
  const before = await h.waitUntilCount(path);
  const { status } = await h.call(method, path, body === undefined ? {} : { body });
  return { status, waitUntil: (await h.waitUntilCount(path)) - before };
}

/** A site that is live: approved, so its pointer and pages are in LIVE (a takedown's clean-up has something to delete). */
async function liveSite() {
  const site = await h.pendingSite();
  expect((await h.call("POST", `/api/admin/versions/${site.versionId}/approve`, { body: { htmlSha256: site.htmlSha256 } })).status).toBe(200);
  return site;
}

describe("list queries read only what their views output (moderator ruling, 2026-09-30)", () => {
  it("names its columns: no *, and no big JSON column", () => {
    for (const sql of [SITE_LIST, VERSION_HISTORY, SITE_AUDIT]) expect(sql).not.toMatch(/\*|brief_json|document_json|edits_json|input_json|output_json/);
    // The generation row keeps GenerationRow's shape with placeholders, and never reads the two big columns.
    expect(GENERATION_HISTORY.replace("'' AS input_json, NULL AS output_json", "")).not.toMatch(/\*|input_json|output_json/);
  });

  it("caps a site's version history at 50, newest first, with only a version summary's fields", async () => {
    const site = await h.pendingSite();
    const db = await h.db();
    const [pending] = (await db.prepare("SELECT * FROM site_versions WHERE id = ?").bind(site.versionId).all<Record<string, unknown>>()).results;
    for (let number = 2; number <= 60; number += 1) {
      await db
        .prepare(
          "INSERT INTO site_versions (id, site_id, number, status, document_json, document_sha256, edits_json, generation_id, pages_json, html_key, html_sha256, stylesheet_sha256, requested_by, requested_at) VALUES (?, ?, ?, 'rejected', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)",
        )
        .bind(newId(), site.siteId, number, pending?.["document_json"], pending?.["document_sha256"], pending?.["edits_json"], pending?.["pages_json"], pending?.["html_key"], pending?.["html_sha256"], pending?.["stylesheet_sha256"], site.ownerId, number)
        .run();
    }
    const detail = await json<{ versions: Array<Record<string, unknown>> }>(await h.call("GET", `/api/admin/sites/${site.siteId}`));
    expect(detail.versions).toHaveLength(50);
    expect(detail.versions.map((v) => v["number"])).toEqual(Array.from({ length: 50 }, (_, i) => 60 - i));
    expect(Object.keys(detail.versions[0] ?? {}).sort()).toEqual(["id", "number", "requestedAt", "reviewNote", "reviewedAt", "status"]);
  });

  it("lists sites without their briefs and gives every listed site its owner", async () => {
    const site = await h.pendingSite();
    const { sites } = await json<{ sites: Array<Record<string, unknown>> }>(await h.call("GET", "/api/admin/sites?filter=draft"));
    expect(sites.some((s) => s["id"] === site.siteId)).toBe(false);
    const all = await json<{ sites: Array<Record<string, unknown>> }>(await h.call("GET", "/api/admin/sites"));
    const row = all.sites.find((s) => s["id"] === site.siteId);
    expect(row).toMatchObject({ ownerId: site.ownerId, ownerEmail: site.email, inReview: true, live: false, takenDown: false });
    expect(JSON.stringify(row)).not.toContain("tone");
  });

  it("keeps the generation's cost and drops its stored input and output", async () => {
    const site = await h.pendingSite();
    const { generations } = await json<{ generations: Array<Record<string, unknown>> }>(await h.call("GET", `/api/admin/sites/${site.siteId}`));
    expect(Object.keys(generations[0] ?? {}).sort()).toEqual(["attempts", "costMicrousd", "createdAt", "errorCode", "fallbackReason", "finishedAt", "id", "kind", "model", "modelSlot", "provider", "status", "usedFallback"]);
  });
});

describe("multi-write publishing calls run to their end (web-maker-f4, 2026-09-30)", () => {
  // Plan 2's takeDown (D1 batch, LIVE delete, MEDIA purge) and restore (LIVE put, D1 batch) are several writes that a
  // client that goes away could cut short, so each goes to waitUntil (runToEnd). The takedown's owner email is a
  // setIndexable is one D1 batch, so it gets none. The takedown's owner email is awaited inside the takedown's own
  // promise (one waitUntil), so the answer can say whether the owner was told.
  it("hands the takedown, the restore and nothing for the search-engine switch to waitUntil", async () => {
    const site = await h.pendingSite();
    await h.call("POST", `/api/admin/versions/${site.versionId}/approve`, { body: { htmlSha256: site.htmlSha256 } });
    const takedown = `/api/admin/sites/${site.siteId}/takedown`;
    const restore = `/api/admin/sites/${site.siteId}/restore`;
    const indexable = `/api/admin/sites/${site.siteId}/indexable`;
    const observed = {
      takedown: await handedOver("POST", takedown, { reason: "Spam report" }),
      restore: await handedOver("POST", restore, await h.restoreBody(site.siteId)),
      indexable: await handedOver("PUT", indexable, { indexable: false }),
      unknownTakedown: await handedOver("POST", `/api/admin/sites/${newId()}/takedown`, { reason: "x" }),
    };
    expect(observed).toEqual({
      takedown: { status: 200, waitUntil: 1 },
      restore: { status: 200, waitUntil: 1 },
      indexable: { status: 200, waitUntil: 0 },
      unknownTakedown: { status: 404, waitUntil: 0 },
    });
    await h.backgroundDone(takedown);
  });

  it("restoring a never-live site still hands the call over (409)", async () => {
    const site = await h.pendingSite();
    expect(await handedOver("POST", `/api/admin/sites/${site.siteId}/restore`, { expectedTakenDownAt: 1 })).toEqual({ status: 409, waitUntil: 1 });
  });
});

describe("the takedown notice (web-maker-f4, 2026-09-30: awaited after the commit, answered as noticeSent)", () => {
  it("answers noticeSent true when the owner's email went out", async () => {
    const site = await h.pendingSite();
    const path = `/api/admin/sites/${site.siteId}/takedown`;
    const res = await h.call("POST", path, { body: { reason: "Spam report" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ noticeSent: true });
    // Awaited before the answer: the email is already in the outbox, with no wait for the background.
    expect((await h.outbox(site.email)).filter((m) => m.tag === "site_notice")).toHaveLength(1);
    await h.backgroundDone(path);
  });

  it("does not undo a takedown when the email cannot be sent: 200 noticeSent false, one log line with only the code", async () => {
    const site = await h.pendingSite();
    await (await h.db()).prepare("UPDATE owners SET email = ? WHERE id = ?").bind("owner@mail-fails.example", site.ownerId).run();
    h.server.clearLogs();
    const path = `/api/admin/sites/${site.siteId}/takedown`;
    const res = await h.call("POST", path, { body: { reason: "Spam report" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ noticeSent: false });
    await h.backgroundDone(path);
    const row = await (await h.db()).prepare("SELECT taken_down_at FROM sites WHERE id = ?").bind(site.siteId).first<{ taken_down_at: number | null }>();
    expect(row?.taken_down_at).not.toBeNull();
    expect(h.logLines().filter((l) => l["event"] === "email_failed")).toEqual([{ event: "email_failed", tag: "site_notice", error: "rejected" }]);
    expect(JSON.stringify(h.logLines())).not.toContain("mail-fails");
  });

  it("counts the reason in code points like zod: 1000 emoji are taken (200), 1001 are refused (422) and change nothing", async () => {
    const site = await h.pendingSite();
    const path = `/api/admin/sites/${site.siteId}/takedown`;
    const refused = await h.call("POST", path, { body: { reason: "\u{1F600}".repeat(1001) } });
    expect(refused.status).toBe(422);
    const row = () => h.db().then((db) => db.prepare("SELECT taken_down_at FROM sites WHERE id = ?").bind(site.siteId).first<{ taken_down_at: number | null }>());
    expect((await row())?.taken_down_at).toBeNull();
    const res = await h.call("POST", path, { body: { reason: "\u{1F600}".repeat(1000) } });
    expect(res.status).toBe(200);
    expect((await row())?.taken_down_at).not.toBeNull();
    await h.backgroundDone(path);
  });

  it("says the owner was not told when the email service is rate limited (the daily cap case)", async () => {
    const site = await h.pendingSite();
    await (await h.db()).prepare("UPDATE owners SET email = ? WHERE id = ?").bind("owner@mail-rate-limited.example", site.ownerId).run();
    const res = await h.call("POST", `/api/admin/sites/${site.siteId}/takedown`, { body: { reason: "Spam report" } });
    expect(await res.json()).toEqual({ noticeSent: false });
  });
});

describe("the takedown's throw paths in the pointer-first order (web-maker-f4, 2026-09-30, option b; A16 order)", () => {
  const takedown = (siteId: string) => `/api/admin/sites/${siteId}/takedown`;
  const notices = async (email: string) => (await h.outbox(email)).filter((m) => m.tag === "site_notice");
  const downAt = async (siteId: string) =>
    (await (await h.db()).prepare("SELECT taken_down_at FROM sites WHERE id = ?").bind(siteId).first<{ taken_down_at: number | null }>())?.taken_down_at;

  it("still tells the owner when cleanup throws after the commit: 200 noticeSent true, cleanupFailed true, one log line with the site id only", async () => {
    const site = await liveSite();
    h.server.clearLogs();
    const res = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "prefix-delete" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ noticeSent: true, cleanupFailed: true });
    expect(await notices(site.email)).toHaveLength(1);
    expect(await downAt(site.siteId)).not.toBeNull();
    expect(h.logLines().filter((l) => l["event"] === "takedown_cleanup_failed")).toEqual([{ event: "takedown_cleanup_failed", siteId: site.siteId }]);
    expect(JSON.stringify(h.logLines())).not.toContain(site.email);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("says both when cleanup throws and the email fails: 200 noticeSent false, cleanupFailed true, the site stays down", async () => {
    const site = await liveSite();
    await (await h.db()).prepare("UPDATE owners SET email = ? WHERE id = ?").bind("cleanup@mail-fails.example", site.ownerId).run();
    const res = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "prefix-delete" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ noticeSent: false, cleanupFailed: true });
    expect(await downAt(site.siteId)).not.toBeNull();
    await h.backgroundDone(takedown(site.siteId));
  });

  it("rethrows a non-PublishError when the D1 batch fails (the site is NOT down): 500, no notice, and the pointer is already gone, so the site shows nothing", async () => {
    const site = await h.pendingSite();
    await h.call("POST", `/api/admin/versions/${site.versionId}/approve`, { body: { htmlSha256: site.htmlSha256 } });
    const before = await h.liveKeys(site.slug);
    expect(before).toContain(livePointerKey(site.slug));
    const res = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "before-commit" } });
    expect(res.status).toBe(500);
    expect(await downAt(site.siteId)).toBeNull();
    expect(await notices(site.email)).toHaveLength(0);
    // The pointer went first: D1 still says live, but every page already stopped; the pages themselves wait for the retry.
    expect(await h.liveKeys(site.slug)).toEqual(before.filter((key) => key !== livePointerKey(site.slug)));
    await h.backgroundDone(takedown(site.siteId));
    // The admin's retry finishes it: down in D1, nothing left in LIVE, one notice.
    expect((await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } })).status).toBe(200);
    expect(await downAt(site.siteId)).not.toBeNull();
    expect(await h.liveKeys(site.slug)).toEqual([]);
    expect(await notices(site.email)).toHaveLength(1);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("changes nothing when the pointer delete fails (step 1): 500, no notice, the site stays up in D1 with its pointer and pages", async () => {
    const site = await h.pendingSite();
    await h.call("POST", `/api/admin/versions/${site.versionId}/approve`, { body: { htmlSha256: site.htmlSha256 } });
    const before = await h.liveKeys(site.slug);
    const res = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "pointer-delete" } });
    expect(res.status).toBe(500);
    expect(await downAt(site.siteId)).toBeNull();
    expect(await notices(site.email)).toHaveLength(0);
    expect(await h.liveKeys(site.slug)).toEqual(before);
    expect((await (await h.db()).prepare("SELECT action FROM audit_log WHERE site_id = ? AND action = 'site.taken_down'").bind(site.siteId).all()).results).toEqual([]);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("rethrows the ORIGINAL error (500, no notice) when the re-read itself throws", async () => {
    const site = await liveSite();
    h.server.clearLogs();
    const res = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "prefix-delete-reread" } });
    expect(res.status).toBe(500);
    expect(await notices(site.email)).toHaveLength(0);
    // The line names the original error's class (a plain Error from LIVE.delete), not the re-read's.
    expect(h.logLines().some((l) => l["error"] === "Error")).toBe(true);
    await h.backgroundDone(takedown(site.siteId));
  });
});

describe("the takedown clean-up retry and the single notice (web-maker-f4, 2026-09-30: retry once, notice only when this call took the site down)", () => {
  const takedown = (siteId: string) => `/api/admin/sites/${siteId}/takedown`;
  const notices = async (email: string) => (await h.outbox(email)).filter((m) => m.tag === "site_notice");

  it("retries the takedown once in the same call: the first LIVE delete throws, the second works -> no cleanupFailed, exactly one notice", async () => {
    const site = await liveSite();
    h.server.clearLogs();
    const res = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "prefix-delete-once" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ noticeSent: true });
    expect(await notices(site.email)).toHaveLength(1);
    expect(h.logLines().filter((l) => l["event"] === "takedown_cleanup_failed")).toEqual([]);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("a re-run on an already-down site sends no notice and answers noticeSent null; its clean-up now works so no cleanupFailed", async () => {
    const site = await liveSite();
    const first = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "prefix-delete" } });
    expect(await first.json()).toEqual({ noticeSent: true, cleanupFailed: true });
    const again = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ noticeSent: null });
    expect(await notices(site.email)).toHaveLength(1);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("a re-run on an already-down site whose clean-up still fails answers cleanupFailed true and still sends no notice", async () => {
    const site = await liveSite();
    await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    // A page left behind (a clean-up that failed earlier): the re-run has something to delete, and the fault stops it.
    await (await h.r2("LIVE")).put(`${site.slug}/${newId()}/home.html`, "<p>left</p>");
    const again = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "prefix-delete" } });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ noticeSent: null, cleanupFailed: true });
    expect(await notices(site.email)).toHaveLength(1);
    await h.backgroundDone(takedown(site.siteId));
  });
});

// A16-4c, 23-A16 round 2 (m6), then takedown-truth (A): a takedown's lease can run out AFTER its D1 commit (the real takeDown asserts the lease
// before its second pointer delete and before the prefix delete), so a lease_lost answer means "the takedown may have committed". The ROUTE tells
// the owner (once) when its own call took the site down, even then; "Finish the takedown" is a re-run and never emails (no ?notice=due any more).
describe("a takedown that loses its lease after the commit (23-A16 f2, m6)", () => {
  const takedown = (siteId: string) => `/api/admin/sites/${siteId}/takedown`;
  const notices = async (email: string) => (await h.outbox(email)).filter((m) => m.tag === "site_notice");
  const downAt = async (siteId: string) =>
    (await (await h.db()).prepare("SELECT taken_down_at FROM sites WHERE id = ?").bind(siteId).first<{ taken_down_at: number | null }>())?.taken_down_at;

  it("answers the takedown lease-lost text (409, no Retry-After), leaves the site down with its pages and sends the owner notice exactly once; Finish sends nothing and clears the pages", async () => {
    const site = await liveSite();
    const lost = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "lease-lost-after-batch" } });
    expect(lost.status).toBe(409);
    expect(lost.headers.get("Retry-After")).toBeNull();
    // noticeSent true: this call took the site down and the owner's email went out (the admin is told so).
    expect(await json<{ error: { code: string; message: string; noticeSent?: boolean | null } }>(lost)).toEqual({
      error: { code: "conflict", message: "This takedown ran too long and was stopped before it finished. Reload; if the site shows as taken down, press Finish the takedown.", noticeSent: true },
    });
    // The commit stood: down in D1, the pointer already gone, the pages still in LIVE, and the owner told by the call that took the site down.
    expect(await downAt(site.siteId)).not.toBeNull();
    const left = await h.liveKeys(site.slug);
    expect(left.length).toBeGreaterThan(0);
    expect(left).not.toContain(livePointerKey(site.slug));
    expect(await notices(site.email)).toHaveLength(1);
    await h.backgroundDone(takedown(site.siteId));

    // Finish is a re-run: it clears the pages and tells nobody, with or without the old ?notice=due (the route ignores it now).
    const finished = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    expect(finished.status).toBe(200);
    expect(await finished.json()).toEqual({ noticeSent: null });
    expect(await notices(site.email)).toHaveLength(1);
    expect(await h.liveKeys(site.slug)).toEqual([]);
    await h.backgroundDone(takedown(site.siteId));
    expect(await (await h.call("POST", `${takedown(site.siteId)}?notice=due`, { body: { reason: "Spam report" } })).json()).toEqual({ noticeSent: null });
    expect(await notices(site.email)).toHaveLength(1);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("a lost lease after the commit with a notice email that FAILS answers the 409 with noticeSent false (the admin must know the owner was not told), and no notice is in the outbox", async () => {
    const site = await liveSite();
    await (await h.db()).prepare("UPDATE owners SET email = ? WHERE id = ?").bind("lease@mail-fails.example", site.ownerId).run();
    const lost = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "lease-lost-after-batch" } });
    expect(lost.status).toBe(409);
    // Case A: the failed email is DEFINITE (false), never "unknown".
    expect(await json(lost)).toEqual({ error: { code: "conflict", message: TAKEDOWN_LEASE_LOST, noticeSent: false } });
    expect(await downAt(site.siteId)).not.toBeNull();
    expect(await notices("lease@mail-fails.example")).toHaveLength(0);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("a lease lost BEFORE the commit (the site stays up) is the same 409 with no notice and no audit row: only the call that took the site down emails", async () => {
    const site = await liveSite();
    const lost = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "lease-lost-before-batch" } });
    expect(lost.status).toBe(409);
    // noticeSent null: this call did not take the site down, so no notice was its to send.
    expect((await json<{ error: { noticeSent?: boolean | null } }>(lost)).error.noticeSent).toBeNull();
    expect(await downAt(site.siteId)).toBeNull();
    expect(await notices(site.email)).toHaveLength(0);
    expect((await (await h.db()).prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'site.taken_down' AND site_id = ?").bind(site.siteId).first<{ n: number }>())?.n).toBe(0);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("when takeDown loses its lease AFTER the commit and the re-read also fails, nothing is sent and the 409 says the notice outcome is unknown: noticeSent null, noticeUnknown true", async () => {
    const site = await liveSite();
    const lost = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "lease-lost-after-batch-reread" } });
    expect(lost.status).toBe(409);
    expect(await json(lost)).toEqual({ error: { code: "conflict", message: TAKEDOWN_LEASE_LOST, noticeSent: null, noticeUnknown: true } });
    expect(await downAt(site.siteId)).not.toBeNull();
    expect(await notices(site.email)).toHaveLength(0);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("when takeDown loses its lease BEFORE the commit (the site stays up) and the re-read also fails, no notice goes to the owner and the 409 says the notice outcome is unknown: noticeSent null, noticeUnknown true", async () => {
    const site = await liveSite();
    const lost = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "lease-lost-before-batch-reread" } });
    expect(lost.status).toBe(409);
    expect(await json(lost)).toEqual({ error: { code: "conflict", message: TAKEDOWN_LEASE_LOST, noticeSent: null, noticeUnknown: true } });
    expect(await downAt(site.siteId)).toBeNull();
    expect(await notices(site.email)).toHaveLength(0);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("when takeDown RETURNED and only the re-read fails, the notice still goes out (the commit is certain: toward sending) and the answer is 200 noticeSent true", async () => {
    const site = await liveSite();
    const res = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "reread-only" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ noticeSent: true });
    expect(await downAt(site.siteId)).not.toBeNull();
    expect(await notices(site.email)).toHaveLength(1);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("a re-run (the site is already down) that loses its lease with a failed re-read answers 409 noticeSent null, never false: the first takedown already told the owner", async () => {
    const site = await liveSite();
    expect((await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } })).status).toBe(200);
    await h.backgroundDone(takedown(site.siteId));
    expect(await notices(site.email)).toHaveLength(1);
    const at = await downAt(site.siteId);
    expect(at).not.toBeNull();
    const rerun = await h.call("POST", takedown(site.siteId), { body: { reason: "Finish", expectedTakenDownAt: at }, headers: { "X-Test-Takedown-Fault": "lease-lost-after-batch-reread" } });
    expect(rerun.status).toBe(409);
    expect(await json(rerun)).toEqual({ error: { code: "conflict", message: TAKEDOWN_LEASE_LOST, noticeSent: null } });
    await h.backgroundDone(takedown(site.siteId));
    expect(await notices(site.email)).toHaveLength(1);
    expect(await downAt(site.siteId)).toBe(at);
  });

  it("a takedown on a site another admin action holds is 409 with Retry-After and the busy text, and changes nothing", async () => {
    const site = await liveSite();
    const db = await h.db();
    await db.prepare("UPDATE sites SET admin_lock = 'someone-else', admin_lock_until = ? WHERE id = ?").bind(Date.now() + 60_000, site.siteId).run();
    const before = await h.liveKeys(site.slug);
    const res = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    expect(res.status).toBe(409);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await json<{ error: { message: string } }>(res)).toMatchObject({ error: { message: "Another admin action on this site is still running. Try again in a minute." } });
    expect(await downAt(site.siteId)).toBeNull();
    expect(await h.liveKeys(site.slug)).toEqual(before);
    expect(await notices(site.email)).toHaveLength(0);
    expect((await db.prepare("SELECT admin_lock FROM sites WHERE id = ?").bind(site.siteId).first<{ admin_lock: string }>())?.admin_lock).toBe("someone-else");
    await h.backgroundDone(takedown(site.siteId));
  });

  it("the lease-lost fault frees only the site the request acts on: another site's lease is still held afterwards", async () => {
    const site = await liveSite();
    const other = await h.pendingSite();
    const db = await h.db();
    await db.prepare("UPDATE sites SET admin_lock = 'other-action', admin_lock_until = ? WHERE id = ?").bind(Date.now() + 60_000, other.siteId).run();
    const lost = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "lease-lost-after-batch" } });
    expect(lost.status).toBe(409);
    expect((await db.prepare("SELECT admin_lock FROM sites WHERE id = ?").bind(other.siteId).first<{ admin_lock: string }>())?.admin_lock).toBe("other-action");
    await h.backgroundDone(takedown(site.siteId));
  });
});

describe("the takedown audit rows (web-maker-f4, 2026-09-30: a re-run is recorded by the route; the fake mirrors Plan 2)", () => {
  const takedown = (siteId: string) => `/api/admin/sites/${siteId}/takedown`;
  type Row = { actor: string; detail: Record<string, unknown> };
  const rows = async (siteId: string): Promise<Row[]> =>
    (await (await h.db()).prepare("SELECT actor, detail_json FROM audit_log WHERE action = 'site.taken_down' AND site_id = ? ORDER BY id").bind(siteId).all<{ actor: string; detail_json: string }>()).results.map(
      (r) => ({ actor: r.actor, detail: JSON.parse(r.detail_json) as Record<string, unknown> }),
    );
  const reasonOnSite = async (siteId: string) =>
    (await (await h.db()).prepare("SELECT takedown_reason FROM sites WHERE id = ?").bind(siteId).first<{ takedown_reason: string | null }>())?.takedown_reason;

  it("a first takedown leaves exactly one audit row, and it is not marked as a repeat", async () => {
    const site = await h.pendingSite();
    expect((await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } })).status).toBe(200);
    expect(await rows(site.siteId)).toEqual([{ actor: expect.stringMatching(/^admin:/), detail: { reason: "Spam report", purgeMedia: false } }]);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("a re-run adds exactly one route row with repeat true (its purge deleted nothing)", async () => {
    const site = await h.pendingSite();
    await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    const again = await h.call("POST", takedown(site.siteId), { body: { reason: "Second reason" } });
    expect(again.status).toBe(200);
    const all = await rows(site.siteId);
    expect(all).toHaveLength(2);
    expect(all[1]).toEqual({ actor: expect.stringMatching(/^admin:/), detail: { reason: "Second reason", purgeMedia: false, repeat: true } });
    expect(all.filter((r) => r.detail["repeat"] === true)).toHaveLength(1);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("a re-run keeps the first takedown reason on the site row", async () => {
    const site = await h.pendingSite();
    await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    await h.call("POST", takedown(site.siteId), { body: { reason: "Second reason" } });
    expect(await reasonOnSite(site.siteId)).toBe("Spam report");
    await h.backgroundDone(takedown(site.siteId));
  });

  it("a re-run that also purges nothing writes no Plan 2 row; one that deletes an object writes Plan 2's later-purge row too", async () => {
    const site = await h.pendingSite();
    await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report", purgeMedia: true } });
    expect(await rows(site.siteId)).toHaveLength(2);
    await (await h.r2("MEDIA")).put(`${site.siteId}/late.jpg`, "x");
    await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report", purgeMedia: true } });
    const all = await rows(site.siteId);
    expect(all).toHaveLength(4);
    expect(all.filter((r) => r.detail["repeat"] === true)).toHaveLength(3);
    await h.backgroundDone(takedown(site.siteId));
  });
});

describe("takedown and restore on the pointer model (A16)", () => {
  const takedown = (siteId: string) => `/api/admin/sites/${siteId}/takedown`;
  const restore = (siteId: string) => `/api/admin/sites/${siteId}/restore`;
  const audits = async (siteId: string) => (await (await h.db()).prepare("SELECT action FROM audit_log WHERE site_id = ? ORDER BY id").bind(siteId).all<{ action: string }>()).results.map((r) => r.action);

  it("a takedown leaves no pointer and nothing under <slug>/, including an older version's page; a restore brings every page and the pointer back", async () => {
    const site = await liveSite();
    const neighbour = await liveSite();
    const live = await h.liveKeys(site.slug);
    expect(live).toHaveLength(1 + 4); // the pointer and the version's four pages (Home, Services, About, Contact)
    expect(live).toContain(livePointerKey(site.slug));
    for (const page of ["home", "services", "about", "contact"] as const) expect(live).toContain(livePageKey(site.slug, site.versionId, page));
    const neighbourKeys = await h.liveKeys(neighbour.slug);
    // A page left over from an older version (a failed clean-up earlier) goes too.
    await (await h.r2("LIVE")).put(`${site.slug}/${newId()}/home.html`, "<p>old</p>");

    expect((await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } })).status).toBe(200);
    expect(await h.liveKeys(site.slug)).toEqual([]);
    expect(await h.liveKeys(neighbour.slug)).toEqual(neighbourKeys);

    const restored = await h.call("POST", restore(site.siteId), { body: await h.restoreBody(site.siteId) });
    expect(restored.status).toBe(200);
    expect(await h.liveKeys(site.slug)).toEqual(live);
    const row = await (await h.db()).prepare("SELECT taken_down_at FROM sites WHERE id = ?").bind(site.siteId).first<{ taken_down_at: number | null }>();
    expect(row?.taken_down_at).toBeNull();
    expect((await (await h.r2("LIVE")).get(livePointerKey(site.slug)))?.customMetadata?.["versionId"]).toBe(site.versionId);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("restoring a site that is already live with its pointer in place changes nothing (healed false); a missing pointer is healed (healed true)", async () => {
    const site = await liveSite();
    const live = await h.liveKeys(site.slug);
    const before = await audits(site.siteId);
    const body = { expectedTakenDownAt: 1 }; // not taken down: Plan 2 does not look at it
    const untouched = await h.call("POST", restore(site.siteId), { body });
    expect(await untouched.json()).toMatchObject({ healed: false });
    expect(await h.liveKeys(site.slug)).toEqual(live);
    await (await h.r2("LIVE")).delete(livePointerKey(site.slug));
    const healed = await h.call("POST", restore(site.siteId), { body });
    expect(await healed.json()).toMatchObject({ healed: true });
    expect(await h.liveKeys(site.slug)).toEqual(live);
    expect(await audits(site.siteId)).toEqual(before); // no D1 row and no audit row for a heal
  });

  it("restoring a version from before A16 (its list of pages is empty) is refused: 500 integrity, nothing copied", async () => {
    const site = await liveSite();
    await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    await (await h.db()).prepare("UPDATE site_versions SET pages_json = '[]' WHERE id = ?").bind(site.versionId).run();
    const res = await h.call("POST", restore(site.siteId), { body: await h.restoreBody(site.siteId) });
    expect(res.status).toBe(500);
    expect(await h.liveKeys(site.slug)).toEqual([]);
  });
});

describe("settings storage (Plan 3 reads generation OFF only when the setting is exactly the string \"false\")", () => {
  it("writes exactly \"false\" and \"true\", and a limit as digits, through the settings route", async () => {
    const stored = async () =>
      Object.fromEntries((await (await h.db()).prepare("SELECT key, value FROM settings").bind().all<{ key: string; value: string }>()).results.map((r) => [r.key, r.value]));
    await h.call("PUT", "/api/admin/settings", { body: { generationEnabled: false } });
    expect(await stored()).toEqual({ "generation.enabled": "false" });
    await h.call("PUT", "/api/admin/settings", { body: { generationEnabled: true, dailyModelLimit: 7 } });
    expect(await stored()).toEqual({ "generation.enabled": "true", "generation.daily_model_limit": "7" });
    // A body that changes nothing writes nothing.
    const audits = async () => (await (await h.db()).prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'settings.updated'").bind().first<{ n: number }>())?.n;
    const before = await audits();
    expect((await h.call("PUT", "/api/admin/settings", { body: {} })).status).toBe(200);
    expect(await audits()).toBe(before);
  });
});

describe("A16-4c: Restore sends the takedown it showed, and Copy the live pages again never touches it (asksite-pages handoff-plan4.md lines 46-69)", () => {
  const takedown = (siteId: string) => `/api/admin/sites/${siteId}/takedown`;
  const restore = (siteId: string) => `/api/admin/sites/${siteId}/restore`;
  const copyAgain = (siteId: string) => `/api/admin/sites/${siteId}/copy-pages`;
  const takenDownAt = async (siteId: string) => (await (await h.db()).prepare("SELECT taken_down_at FROM sites WHERE id = ?").bind(siteId).first<{ taken_down_at: number | null }>())?.taken_down_at;
  const audits = async (siteId: string) => (await (await h.db()).prepare("SELECT action FROM audit_log WHERE site_id = ? ORDER BY id").bind(siteId).all<{ action: string }>()).results.map((r) => r.action);

  it("the site view carries taken_down_at: null while it is up, the takedown's moment once it is down", async () => {
    const site = await liveSite();
    expect((await json<{ takenDownAt: number | null }>(await h.call("GET", `/api/admin/sites/${site.siteId}`))).takenDownAt).toBeNull();
    await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    const shown = (await json<{ takenDownAt: number | null }>(await h.call("GET", `/api/admin/sites/${site.siteId}`))).takenDownAt;
    expect(shown).toBe(await takenDownAt(site.siteId));
    expect(shown).toEqual(expect.any(Number));
    await h.backgroundDone(takedown(site.siteId));
  });

  it("Restore needs the takedown moment the page showed: without it 422, with a different one 423 with the taken-down-again text, and the site stays down with nothing copied", async () => {
    const site = await liveSite();
    await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    const shown = await takenDownAt(site.siteId);
    const audited = await audits(site.siteId);
    expect((await h.call("POST", restore(site.siteId), { body: {} })).status).toBe(422);
    const stale = await h.call("POST", restore(site.siteId), { body: { expectedTakenDownAt: (shown ?? 0) - 1 } });
    expect(stale.status).toBe(423);
    expect(await json<{ error: { code: string; message: string } }>(stale)).toMatchObject({
      error: { code: "site_taken_down", message: "This site was taken down again since you opened this page. Reload to see where it stands now." },
    });
    expect(await takenDownAt(site.siteId)).toBe(shown);
    expect(await h.liveKeys(site.slug)).toEqual([]);
    expect(await audits(site.siteId)).toEqual(audited);
    // The right moment restores.
    expect((await h.call("POST", restore(site.siteId), { body: { expectedTakenDownAt: shown } })).status).toBe(200);
    expect(await takenDownAt(site.siteId)).toBeNull();
    await h.backgroundDone(takedown(site.siteId));
  });

  it("Copy the live pages again copies the pages back (a lost page, a lost pointer), with no D1 change, no audit row and no email", async () => {
    const site = await liveSite();
    const live = await h.liveKeys(site.slug);
    const before = await audits(site.siteId);
    await (await h.r2("LIVE")).delete(livePageKey(site.slug, site.versionId, "about"));
    await (await h.r2("LIVE")).delete(livePointerKey(site.slug));
    const emails = (await h.outbox(site.email)).length;
    const res = await h.call("POST", copyAgain(site.siteId), { body: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ liveUrl: `https://${site.slug}.localhost:8789/` });
    expect(await h.liveKeys(site.slug)).toEqual(live);
    expect(await audits(site.siteId)).toEqual(before);
    expect((await h.outbox(site.email)).length).toBe(emails);
  });

  it("Copy the live pages again on a TAKEN-DOWN site is 409 and leaves taken_down_at, LIVE and the audit log exactly as they were", async () => {
    const site = await liveSite();
    await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    const shown = await takenDownAt(site.siteId);
    const audited = await audits(site.siteId);
    const res = await h.call("POST", copyAgain(site.siteId), { body: {} });
    expect(res.status).toBe(409);
    expect(await takenDownAt(site.siteId)).toBe(shown);
    expect(shown).not.toBeNull();
    expect(await h.liveKeys(site.slug)).toEqual([]);
    expect(await audits(site.siteId)).toEqual(audited);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("Copy the live pages again checks taken-down BEFORE not-live, as the real one does: a taken-down site that was never live is told it is taken down", async () => {
    const site = await h.pendingSite();
    await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    const res = await h.call("POST", copyAgain(site.siteId), { body: {} });
    expect(res.status).toBe(409);
    expect(await json<{ error: { message: string } }>(res)).toMatchObject({ error: { message: "This site is taken down, so there is nothing to copy. Reload to see where it stands now." } });
    await h.backgroundDone(takedown(site.siteId));
  });

  it("an integrity failure copies NOTHING: the stored pages are proved before the first LIVE write (Copy the live pages again)", async () => {
    const site = await liveSite();
    // LIVE lost two pages; a stored page (WORK) no longer has the bytes it was approved with.
    const live = await h.r2("LIVE");
    const work = await h.r2("WORK");
    await live.delete(livePageKey(site.slug, site.versionId, "about"));
    await live.delete(livePointerKey(site.slug));
    const afterLoss = await h.liveKeys(site.slug);
    const stored = versionPageKey(site.siteId, site.versionId, "services");
    expect(await work.get(stored)).not.toBeNull();
    await work.put(stored, "<p>tampered</p>");
    const res = await h.call("POST", copyAgain(site.siteId), { body: {} });
    expect(res.status).toBe(500);
    expect(await json<{ error: { message: string } }>(res)).toMatchObject({ error: { message: "The stored pages don't match what was approved, so nothing was copied." } });
    expect(await h.liveKeys(site.slug)).toEqual(afterLoss); // not one key written
  });

  it("an action on a site another admin action holds is 409 with Retry-After, changes nothing, and leaves that action's lease alone; once the lease runs out it works", async () => {
    const site = await liveSite();
    const db = await h.db();
    const hold = (until: number) => db.prepare("UPDATE sites SET admin_lock = 'someone-else', admin_lock_until = ? WHERE id = ?").bind(until, site.siteId).run();
    await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    const body = await h.restoreBody(site.siteId);
    await hold(Date.now() + 60_000);
    for (const [path, payload] of [[restore(site.siteId), body], [copyAgain(site.siteId), {}]] as const) {
      const res = await h.call("POST", path, { body: payload });
      expect(res.status).toBe(409);
      expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
      expect(await json<{ error: { code: string; message: string; retryAfter?: number } }>(res)).toMatchObject({
        error: { code: "conflict", message: "Another admin action on this site is still running. Try again in a minute." },
      });
    }
    expect(await takenDownAt(site.siteId)).not.toBeNull();
    expect((await db.prepare("SELECT admin_lock FROM sites WHERE id = ?").bind(site.siteId).first<{ admin_lock: string }>())?.admin_lock).toBe("someone-else");
    await hold(Date.now() - 1000);
    expect((await h.call("POST", restore(site.siteId), { body })).status).toBe(200);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("a rejected pointer write on Restore is live_copy_failed with its own text; the site stays down and Restore again works", async () => {
    const site = await liveSite();
    await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    const body = await h.restoreBody(site.siteId);
    const res = await h.call("POST", restore(site.siteId), { body, headers: { "X-Test-Takedown-Fault": "pointer-write" } });
    expect(res.status).toBe(500);
    expect(await json<{ error: { message: string } }>(res)).toMatchObject({ error: { message: "The site is still offline: its pages could not be put back. Press Restore again." } });
    expect(await takenDownAt(site.siteId)).not.toBeNull();
    expect((await h.call("POST", restore(site.siteId), { body })).status).toBe(200);
    await h.backgroundDone(takedown(site.siteId));
  });

  // Plan 2's take-back rule (shared.ts takeBackPointer, holdsDownSite): when the re-read shows the site down AND this call holds the
  // lease, the pointer goes whoever wrote it, so a stale pointer an earlier failed take-back left cannot stay on a down site.
  it("a failed Restore takes a stale pointer another writer left out of the down site, as the real take-back does", async () => {
    const site = await liveSite();
    await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    await h.backgroundDone(takedown(site.siteId));
    const body = await h.restoreBody(site.siteId);
    await (await h.r2("LIVE")).put(livePointerKey(site.slug), "");
    expect(await h.liveKeys(site.slug)).toEqual([livePointerKey(site.slug)]);
    const res = await h.call("POST", restore(site.siteId), { body, headers: { "X-Test-Takedown-Fault": "pointer-write" } });
    expect(res.status).toBe(500);
    expect(await json<{ error: { message: string } }>(res)).toMatchObject({ error: { message: RESTORE_LIVE_COPY_FAILED } });
    expect(await takenDownAt(site.siteId)).not.toBeNull();
    expect(await h.liveKeys(site.slug)).not.toContain(livePointerKey(site.slug));
  });

  // Plan 2's restore (site-state.ts:208-224): the clear is fenced on the lease (RESTORE_SITE_SQL); 0 rows changed is site_busy lease_lost
  // after pointerBackIfDown. The restore's own pointer is taken back (the site is down; it wrote it) and nothing is stored.
  it("a Restore that loses its lease before its clear is 409 with the lease-lost text, stays down and leaves no pointer it wrote", async () => {
    const site = await liveSite();
    await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    await h.backgroundDone(takedown(site.siteId));
    const body = await h.restoreBody(site.siteId);
    const shown = await takenDownAt(site.siteId);
    const res = await h.call("POST", restore(site.siteId), { body, headers: { "X-Test-Takedown-Fault": "lease-lost-before-batch" } });
    expect(res.status).toBe(409);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(await json<{ error: { code: string; message: string } }>(res)).toEqual({ error: { code: "conflict", message: LEASE_LOST } });
    expect(await takenDownAt(site.siteId)).toBe(shown);
    expect(shown).not.toBeNull();
    expect(await h.liveKeys(site.slug)).not.toContain(livePointerKey(site.slug));
    const restored = await (await h.db()).prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'site.restored' AND site_id = ?").bind(site.siteId).first<{ n: number }>();
    expect(restored?.n).toBe(0); // a restore that did not happen is not audited
  });

  // Plan 2's takeBackPointer (shared.ts:220-241): without the lease on the down site, only the pointer THIS call wrote goes.
  it("a Restore take-back never deletes another call's pointer when the site is not down under this call's lease", async () => {
    const site = await liveSite();
    await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    await h.backgroundDone(takedown(site.siteId));
    const body = await h.restoreBody(site.siteId);
    const res = await h.call("POST", restore(site.siteId), { body, headers: { "X-Test-Takedown-Fault": "lease-taken-over-before-batch" } });
    expect(res.status).toBe(409);
    expect(await json<{ error: { message: string } }>(res)).toMatchObject({ error: { message: LEASE_LOST } });
    const pointer = await (await h.r2("LIVE")).get(livePointerKey(site.slug));
    expect(pointer?.customMetadata?.["writer"]).toBe("another-call");
  });
});

// Task 26 step 4 (lane B fix, 2026-10-05): "this call took the site down" is decided AFTER takeDown runs. Two admins whose reads both
// saw the site up must not email the owner twice: only the call whose own timestamp is the stored taken_down_at sends the notice.
// takedown-truth (B): every Finish sends the takedown moment its page showed; a site restored (or taken down again) since is refused BEFORE takeDown.
describe("a Finish the takedown from a stale page is refused (takedown-truth B)", () => {
  const takedown = (siteId: string) => `/api/admin/sites/${siteId}/takedown`;
  const notices = async (email: string) => (await h.outbox(email)).filter((m) => m.tag === "site_notice");
  const downAt = async (siteId: string) =>
    (await (await h.db()).prepare("SELECT taken_down_at FROM sites WHERE id = ?").bind(siteId).first<{ taken_down_at: number | null }>())?.taken_down_at;
  const auditCount = async (siteId: string) => (await (await h.db()).prepare("SELECT COUNT(*) AS n FROM audit_log WHERE site_id = ?").bind(siteId).first<{ n: number }>())?.n;
  const STALE = "This site was restored since you opened this page. Reload to see where it stands now.";

  it("a site restored since the page showed it down: 409 with the text, no notice, no audit row, the site stays up", async () => {
    const site = await liveSite();
    await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    const shown = await downAt(site.siteId);
    await h.backgroundDone(takedown(site.siteId));
    expect((await h.call("POST", `/api/admin/sites/${site.siteId}/restore`, { body: { expectedTakenDownAt: shown } })).status).toBe(200);
    const keys = await h.liveKeys(site.slug);
    const audits = await auditCount(site.siteId);
    expect(await notices(site.email)).toHaveLength(1);

    const stale = await h.call("POST", takedown(site.siteId), { body: { reason: "Stale finish", expectedTakenDownAt: shown } });
    expect(stale.status).toBe(409);
    expect(await json<{ error: { code: string; message: string } }>(stale)).toEqual({ error: { code: "conflict", message: STALE } });
    expect(await downAt(site.siteId)).toBeNull();
    expect(await h.liveKeys(site.slug)).toEqual(keys);
    expect(await notices(site.email)).toHaveLength(1);
    expect(await auditCount(site.siteId)).toBe(audits);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("a site down at a DIFFERENT moment than the page showed: the same 409, and nothing changes", async () => {
    const site = await liveSite();
    await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    const shown = (await downAt(site.siteId)) ?? 0;
    const audits = await auditCount(site.siteId);
    for (const wrong of [shown - 1, shown + 1]) {
      const stale = await h.call("POST", takedown(site.siteId), { body: { reason: "Stale finish", expectedTakenDownAt: wrong } });
      expect(stale.status).toBe(409);
      expect(await json<{ error: { message: string } }>(stale)).toMatchObject({ error: { message: STALE } });
    }
    expect(await downAt(site.siteId)).toBe(shown);
    expect(await notices(site.email)).toHaveLength(1);
    expect(await auditCount(site.siteId)).toBe(audits);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("the moment the page showed finishes the takedown: 200, no notice, one repeat audit row; a first takedown without it is unchanged", async () => {
    const site = await liveSite();
    const first = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    expect(await first.json()).toEqual({ noticeSent: true });
    const shown = await downAt(site.siteId);
    const finish = await h.call("POST", takedown(site.siteId), { body: { reason: "Finishing", expectedTakenDownAt: shown } });
    expect(finish.status).toBe(200);
    expect(await finish.json()).toEqual({ noticeSent: null });
    expect(await notices(site.email)).toHaveLength(1);
    expect(await downAt(site.siteId)).toBe(shown);
    const repeats = (await (await h.db()).prepare("SELECT detail_json FROM audit_log WHERE action = 'site.taken_down' AND site_id = ?").bind(site.siteId).all<{ detail_json: string }>()).results.filter((r) => JSON.parse(r.detail_json).repeat === true);
    expect(repeats).toHaveLength(1);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("the extra field is checked: not a positive whole number is 422, and an unknown field is still 422 (the body stays strict)", async () => {
    const site = await liveSite();
    for (const bad of [0, -5, 1.5, "1"]) {
      expect((await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report", expectedTakenDownAt: bad } })).status).toBe(422);
    }
    expect((await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report", expectedTakenDownAt: 5, surprise: true } })).status).toBe(422);
    expect(await downAt(site.siteId)).toBeNull();
    await h.backgroundDone(takedown(site.siteId));
  });
});

describe("the takedown notice is sent once when two admins act at the same time", () => {
  const takedown = (siteId: string) => `/api/admin/sites/${siteId}/takedown`;
  const notices = async (email: string) => (await h.outbox(email)).filter((m) => m.tag === "site_notice");
  const auditRows = async (siteId: string) =>
    (await (await h.db()).prepare("SELECT actor, detail_json FROM audit_log WHERE action = 'site.taken_down' AND site_id = ? ORDER BY id").bind(siteId).all<{ actor: string; detail_json: string }>()).results.map(
      (r) => ({ actor: r.actor, detail: JSON.parse(r.detail_json) as Record<string, unknown> }),
    );

  it("a second admin whose site read came before the first admin's commit sends no second notice, and its call is audited as a repeat", async () => {
    const site = await liveSite();
    const second = await accessToken({ email: "second@example.com" });
    // Admin B's request starts first (its read sees the site up) but its lease step waits 2 s; admin A takes the site down meanwhile.
    const b = h.call("POST", takedown(site.siteId), { token: second, headers: { "X-Test-Delay-Lease-Ms": "2000" }, body: { reason: "B reason", ownerMessage: "Message from admin B" } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const a = await h.call("POST", takedown(site.siteId), { body: { reason: "A reason", ownerMessage: "Message from admin A" } });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ noticeSent: true });
    const bRes = await b;
    expect(bRes.status).toBe(200);
    expect(await bRes.json()).toEqual({ noticeSent: null });
    await h.backgroundDone(takedown(site.siteId));
    const sent = await notices(site.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("Message from admin A");
    expect(sent[0]?.text).not.toContain("Message from admin B");
    expect(await auditRows(site.siteId)).toEqual([
      { actor: "admin:admin@example.com", detail: { reason: "A reason", purgeMedia: false } },
      { actor: "admin:second@example.com", detail: { reason: "B reason", purgeMedia: false, repeat: true } },
    ]);
  });

  it("the retry path still sends exactly one notice and one audit row (the first LIVE delete throws after the commit, the retry finishes)", async () => {
    const site = await liveSite();
    const res = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "prefix-delete-once" } });
    expect(await res.json()).toEqual({ noticeSent: true });
    expect(await notices(site.email)).toHaveLength(1);
    expect(await auditRows(site.siteId)).toEqual([{ actor: "admin:admin@example.com", detail: { reason: "Spam report", purgeMedia: false } }]);
    await h.backgroundDone(takedown(site.siteId));
  });
});

describe("the takedown's owner message is cleaned at the route input (lane B fix, 2026-10-05)", () => {
  const takedown = (siteId: string) => `/api/admin/sites/${siteId}/takedown`;
  const notice = async (email: string) => (await h.outbox(email)).find((m) => m.tag === "site_notice");

  it("removes hidden characters from the email text and keeps newlines and U+200D", async () => {
    const site = await h.pendingSite();
    const res = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report", ownerMessage: "Please\u202E reply\u200B soon.\nThank \u{1F468}\u200D\u{1F469} you." } });
    expect(await res.json()).toEqual({ noticeSent: true });
    const text = (await notice(site.email))?.text ?? "";
    expect(text).toContain("Please reply soon.\nThank \u{1F468}\u200D\u{1F469} you.");
    expect(text).not.toMatch(/[\u202E\u200B]/);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("turns a lone CR into a newline, not into nothing", async () => {
    const site = await h.pendingSite();
    await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report", ownerMessage: "line one\rline two" } });
    expect((await notice(site.email))?.text).toContain("line one\nline two");
    await h.backgroundDone(takedown(site.siteId));
  });

  it("treats a message that is empty after cleaning as no message: 200, the notice goes out without it", async () => {
    const site = await h.pendingSite();
    const res = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report", ownerMessage: "\u200B\u202E " } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ noticeSent: true });
    const empty = await h.pendingSite();
    await h.call("POST", takedown(empty.siteId), { body: { reason: "Spam report" } });
    expect((await notice(site.email))?.text.replace(site.email, "")).toBe((await notice(empty.email))?.text.replace(empty.email, ""));
    await h.backgroundDone(takedown(site.siteId));
    await h.backgroundDone(takedown(empty.siteId));
  });
});

// I-1 (stale-forms round, DECIDED 2026-10-07): the up-site take-down form names the state its page showed (expectedRestoredAt: the newest site.restored
// moment, null when the site was never restored). A press that finds the site in another state is refused before takeDown: no purge, no email, no audit row.
describe("a takedown names the site state its page showed (expectedRestoredAt)", () => {
  const takedown = (siteId: string) => `/api/admin/sites/${siteId}/takedown`;
  const DOWN_SINCE = "This site was taken down since you opened this page. Reload to see where it stands now.";
  const RESTORED_SINCE = "This site was restored since you opened this page. Reload to see where it stands now.";
  const detail = async (siteId: string) => json<{ takenDownAt: number | null; restoredAt: number | null }>(await h.call("GET", `/api/admin/sites/${siteId}`));
  const count = async (sql: string, ...values: unknown[]) => (await (await h.db()).prepare(sql).bind(...values).first<{ n: number }>())?.n;
  const auditRows = (siteId: string) => count("SELECT COUNT(*) AS n FROM audit_log WHERE site_id = ?", siteId);
  const noticeRows = (email: string) => count("SELECT COUNT(*) AS n FROM dev_outbox WHERE to_addr = ? AND tag = 'site_notice'", email);
  const downThenRestore = async (siteId: string) => {
    expect((await h.call("POST", takedown(siteId), { body: { reason: "First report", purgeMedia: false } })).status).toBe(200);
    await h.backgroundDone(takedown(siteId));
    expect((await h.call("POST", `/api/admin/sites/${siteId}/restore`, { body: await h.restoreBody(siteId) })).status).toBe(200);
  };

  it("refuses a site that is down now with the taken-down text (409) and changes nothing: no purge, no email, no audit row", async () => {
    const site = await liveSite();
    expect((await h.call("POST", takedown(site.siteId), { body: { reason: "Other admin, keep photos", purgeMedia: false } })).status).toBe(200);
    await h.backgroundDone(takedown(site.siteId));
    const rows = await auditRows(site.siteId);
    const notices = await noticeRows(site.email);
    const stamp = (await detail(site.siteId)).takenDownAt;
    const res = await h.call("POST", takedown(site.siteId), { body: { reason: "Stale page", ownerMessage: "Stale message", purgeMedia: true, expectedRestoredAt: null } });
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: { code: "conflict", message: DOWN_SINCE } });
    await h.backgroundDone(takedown(site.siteId));
    expect(await auditRows(site.siteId)).toBe(rows);
    expect(await noticeRows(site.email)).toBe(notices);
    expect((await detail(site.siteId)).takenDownAt).toBe(stamp);
  });

  it("refuses a restore moment that differs from the server's newest (409, the restored text) and changes nothing", async () => {
    const site = await liveSite();
    await downThenRestore(site.siteId);
    const restoredAt = (await detail(site.siteId)).restoredAt;
    expect(restoredAt).toEqual(expect.any(Number));
    const rows = await auditRows(site.siteId);
    const notices = await noticeRows(site.email);
    for (const stale of [null, restoredAt! - 1]) {
      const res = await h.call("POST", takedown(site.siteId), { body: { reason: "Stale page", ownerMessage: "Stale message", purgeMedia: true, expectedRestoredAt: stale } });
      expect(res.status).toBe(409);
      expect(await json(res)).toEqual({ error: { code: "conflict", message: RESTORED_SINCE } });
    }
    await h.backgroundDone(takedown(site.siteId));
    expect(await auditRows(site.siteId)).toBe(rows);
    expect(await noticeRows(site.email)).toBe(notices);
    expect((await detail(site.siteId)).takenDownAt).toBeNull();
  });

  it("takes the site down when the moment matches: null for a never-restored site, the newest restore after a restore", async () => {
    const never = await liveSite();
    expect((await detail(never.siteId)).restoredAt).toBeNull();
    const first = await h.call("POST", takedown(never.siteId), { body: { reason: "Spam report", purgeMedia: false, expectedRestoredAt: null } });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ noticeSent: true });
    await h.backgroundDone(takedown(never.siteId));
    expect((await detail(never.siteId)).takenDownAt).not.toBeNull();

    const again = await liveSite();
    await downThenRestore(again.siteId);
    const { restoredAt } = await detail(again.siteId);
    const second = await h.call("POST", takedown(again.siteId), { body: { reason: "Spam report", purgeMedia: false, expectedRestoredAt: restoredAt } });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ noticeSent: true });
    await h.backgroundDone(takedown(again.siteId));
    expect((await detail(again.siteId)).takenDownAt).not.toBeNull();
  });

  it("keeps today's behaviour for a body with no expectedRestoredAt (Finish and legacy): a re-run on a down site is 200 and sends no notice", async () => {
    const site = await liveSite();
    expect((await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } })).status).toBe(200);
    await h.backgroundDone(takedown(site.siteId));
    const notices = await noticeRows(site.email);
    const again = await h.call("POST", takedown(site.siteId), { body: { reason: "Finish it", purgeMedia: true } });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ noticeSent: null });
    await h.backgroundDone(takedown(site.siteId));
    expect(await noticeRows(site.email)).toBe(notices);
  });

  it("reads the newest restore moment with the audit_site index, not a table scan (EXPLAIN QUERY PLAN)", async () => {
    const site = await liveSite();
    const plan = await (await h.db()).prepare(`EXPLAIN QUERY PLAN ${SITE_LAST_RESTORED}`).bind(site.siteId).all<{ detail: string }>();
    const lines = plan.results.map((r) => r.detail);
    expect(lines.join("\n")).toContain("USING INDEX audit_site (site_id=?)");
    expect(lines.join("\n")).not.toMatch(/SCAN audit_log/);
  });
});
