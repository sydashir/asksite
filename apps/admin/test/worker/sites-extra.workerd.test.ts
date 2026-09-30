import { newId } from "@asksite/core";
import { describe, expect, it } from "vitest";
import { GENERATION_HISTORY, SITE_AUDIT, SITE_LIST, VERSION_HISTORY } from "../../src/worker/queries.ts";
import { json, useAdminHarness } from "../support/harness.ts";

const h = useAdminHarness();

/** How many promises a request to `path` hands to waitUntil, and its status. */
async function handedOver(method: string, path: string, body?: unknown): Promise<{ status: number; waitUntil: number }> {
  const before = await h.waitUntilCount(path);
  const { status } = await h.call(method, path, body === undefined ? {} : { body });
  return { status, waitUntil: (await h.waitUntilCount(path)) - before };
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
          "INSERT INTO site_versions (id, site_id, number, status, document_json, document_sha256, edits_json, generation_id, html_key, html_sha256, stylesheet_sha256, requested_by, requested_at) VALUES (?, ?, ?, 'rejected', ?, ?, ?, NULL, ?, ?, ?, ?, ?)",
        )
        .bind(newId(), site.siteId, number, pending?.["document_json"], pending?.["document_sha256"], pending?.["edits_json"], pending?.["html_key"], pending?.["html_sha256"], pending?.["stylesheet_sha256"], site.ownerId, number)
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
    expect(Object.keys(generations[0] ?? {}).sort()).toEqual(["attempts", "costMicrousd", "createdAt", "errorCode", "fallbackReason", "finishedAt", "id", "kind", "model", "provider", "status", "usedFallback"]);
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
      restore: await handedOver("POST", restore, {}),
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
    expect(await handedOver("POST", `/api/admin/sites/${site.siteId}/restore`, {})).toEqual({ status: 409, waitUntil: 1 });
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

  it("says the owner was not told when the email service is rate limited (the daily cap case)", async () => {
    const site = await h.pendingSite();
    await (await h.db()).prepare("UPDATE owners SET email = ? WHERE id = ?").bind("owner@mail-rate-limited.example", site.ownerId).run();
    const res = await h.call("POST", `/api/admin/sites/${site.siteId}/takedown`, { body: { reason: "Spam report" } });
    expect(await res.json()).toEqual({ noticeSent: false });
  });
});

describe("the takedown's post-commit throw path (web-maker-f4, 2026-09-30, option b)", () => {
  const takedown = (siteId: string) => `/api/admin/sites/${siteId}/takedown`;
  const notices = async (email: string) => (await h.outbox(email)).filter((m) => m.tag === "site_notice");
  const downAt = async (siteId: string) =>
    (await (await h.db()).prepare("SELECT taken_down_at FROM sites WHERE id = ?").bind(siteId).first<{ taken_down_at: number | null }>())?.taken_down_at;

  it("still tells the owner when cleanup throws after the commit: 200 noticeSent true, cleanupFailed true, one log line with the site id only", async () => {
    const site = await h.pendingSite();
    h.server.clearLogs();
    const res = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "live-delete" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ noticeSent: true, cleanupFailed: true });
    expect(await notices(site.email)).toHaveLength(1);
    expect(await downAt(site.siteId)).not.toBeNull();
    expect(h.logLines().filter((l) => l["event"] === "takedown_cleanup_failed")).toEqual([{ event: "takedown_cleanup_failed", siteId: site.siteId }]);
    expect(JSON.stringify(h.logLines())).not.toContain(site.email);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("says both when cleanup throws and the email fails: 200 noticeSent false, cleanupFailed true, the site stays down", async () => {
    const site = await h.pendingSite();
    await (await h.db()).prepare("UPDATE owners SET email = ? WHERE id = ?").bind("cleanup@mail-fails.example", site.ownerId).run();
    const res = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "live-delete" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ noticeSent: false, cleanupFailed: true });
    expect(await downAt(site.siteId)).not.toBeNull();
    await h.backgroundDone(takedown(site.siteId));
  });

  it("rethrows a non-PublishError when the site is NOT down: 500, no notice, site untouched", async () => {
    const site = await h.pendingSite();
    const res = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "before-commit" } });
    expect(res.status).toBe(500);
    expect(await downAt(site.siteId)).toBeNull();
    expect(await notices(site.email)).toHaveLength(0);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("rethrows the ORIGINAL error (500, no notice) when the re-read itself throws", async () => {
    const site = await h.pendingSite();
    h.server.clearLogs();
    const res = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "live-delete-reread" } });
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
    const site = await h.pendingSite();
    h.server.clearLogs();
    const res = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "live-delete-once" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ noticeSent: true });
    expect(await notices(site.email)).toHaveLength(1);
    expect(h.logLines().filter((l) => l["event"] === "takedown_cleanup_failed")).toEqual([]);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("a re-run on an already-down site sends no notice and answers noticeSent null; its clean-up now works so no cleanupFailed", async () => {
    const site = await h.pendingSite();
    const first = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "live-delete" } });
    expect(await first.json()).toEqual({ noticeSent: true, cleanupFailed: true });
    const again = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ noticeSent: null });
    expect(await notices(site.email)).toHaveLength(1);
    await h.backgroundDone(takedown(site.siteId));
  });

  it("a re-run on an already-down site whose clean-up still fails answers cleanupFailed true and still sends no notice", async () => {
    const site = await h.pendingSite();
    await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" } });
    const again = await h.call("POST", takedown(site.siteId), { body: { reason: "Spam report" }, headers: { "X-Test-Takedown-Fault": "live-delete" } });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ noticeSent: null, cleanupFailed: true });
    expect(await notices(site.email)).toHaveLength(1);
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
