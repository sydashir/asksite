import { reviewPageHeaders } from "@asksite/app-common";
import { versionKey, type AdminVersionDetail } from "@asksite/core";
import { describe, expect, it } from "vitest";
import { REVIEW_QUEUE } from "../../src/worker/queries.ts";
import { json, useAdminHarness, VALID_FACTS } from "../support/harness.ts";

const h = useAdminHarness();

type ErrorJson = { error: { code: string; message: string } };

describe("review", () => {
  it("lists pending versions oldest first", async () => {
    const first = await h.pendingSite();
    const second = await h.pendingSite();
    const { items } = await json<{ items: Array<{ version: { id: string }; site: { id: string; ownerEmail: string } }> }>(await h.call("GET", "/api/admin/reviews"));
    const ids = items.map((i) => i.version.id);
    expect(ids.indexOf(first.versionId)).toBeLessThan(ids.indexOf(second.versionId));
    expect(items.find((i) => i.version.id === first.versionId)?.site.ownerEmail).toBe(first.email);
  });

  it("shows the version detail with checks, owner edits and text flags", async () => {
    const facts = { ...VALID_FACTS, testimonials: [{ quote: "Pay at paypa1-help.com", name: "A" }] };
    const site = await h.pendingSite(facts, { reviewsAreReal: true });
    const detail = await json<AdminVersionDetail>(await h.call("GET", `/api/admin/versions/${site.versionId}`));
    expect(detail.version).toMatchObject({ id: site.versionId, siteId: site.siteId, htmlSha256: site.htmlSha256, status: "pending", number: 1 });
    expect(detail.pageUrl).toBe(`/api/admin/versions/${site.versionId}/page`);
    expect(detail.ownerEditedPaths).toEqual(["copy.ctaText"]);
    expect(detail.liveDocument).toBeNull();
    expect(detail.checks).toMatchObject({
      firstPublish: true,
      testimonials: 1,
      reviewsAttested: true,
      hiddenSections: ["faq"],
      photoCount: 0,
      usedFallbackCopy: false,
      textFlags: [{ path: "facts.testimonials.0.quote", reason: "web_address" }],
    });
  });

  // No cap on the text flags (web-maker-d3, 2026-09-30): the admin sees every one. The schema bounds the list:
  // 118 owner strings at their largest counts, each flagged for all four reasons, is 472 flags.
  it("shows every text flag of the most flagged page the facts allow", async () => {
    const flagged = "Verify a.co @ 555-123-4567";
    const photo = { url: "https://media.localhost:8789/a/b.webp", alt: flagged, width: 400, height: 300, caption: flagged };
    const count = (n: number) => Array.from({ length: n }, (_, i) => i);
    const facts = {
      ...VALID_FACTS,
      businessName: flagged,
      location: { streetAddress: flagged, city: flagged, state: "TX" },
      services: count(12).map(() => ({ name: flagged })),
      serviceArea: { places: count(30).map(() => flagged), note: flagged },
      licences: count(5).map(() => ({ label: flagged, number: flagged })),
      testimonials: count(12).map(() => ({ quote: flagged, name: flagged, location: flagged })),
      heroPhoto: photo,
      photos: count(12).map(() => photo),
    };
    const paths = [
      "businessName",
      "location.streetAddress",
      "location.city",
      ...count(12).map((i) => `services.${i}.name`),
      ...count(30).map((i) => `serviceArea.places.${i}`),
      "serviceArea.note",
      ...count(5).flatMap((i) => [`licences.${i}.label`, `licences.${i}.number`]),
      ...count(12).flatMap((i) => [`testimonials.${i}.quote`, `testimonials.${i}.name`, `testimonials.${i}.location`]),
      "heroPhoto.alt",
      "heroPhoto.caption",
      ...count(12).flatMap((i) => [`photos.${i}.alt`, `photos.${i}.caption`]),
    ];
    expect(paths).toHaveLength(118);
    const site = await h.pendingSite(facts);
    const res = await h.call("GET", `/api/admin/versions/${site.versionId}`);
    expect(res.status).toBe(200);
    const reasons = ["web_address", "at_sign", "other_phone", "phishing_word"] as const;
    expect((await json<AdminVersionDetail>(res)).checks.textFlags).toEqual(paths.flatMap((path) => reasons.map((reason) => ({ path: `facts.${path}`, reason }))));
  });

  it("serves the stored page framable only by the admin origin", async () => {
    const site = await h.pendingSite();
    const page = await h.call("GET", `/api/admin/versions/${site.versionId}/page`);
    expect(page.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'self'");
    expect(await page.text()).toContain("Call Joe today");
  });

  it("still opens a version whose stored data a later rule refuses (decision 36)", async () => {
    const site = await h.pendingSite();
    const db = await h.db();
    const row = await db.prepare("SELECT document_json FROM site_versions WHERE id = ?").bind(site.versionId).first<{ document_json: string }>();
    const document = JSON.parse(row?.document_json ?? "{}") as { copy: Record<string, unknown> };
    document.copy["heroHeadline"] = "Call 555 today";
    await db.prepare("UPDATE site_versions SET document_json = ? WHERE id = ?").bind(JSON.stringify(document), site.versionId).run();
    await db.prepare("UPDATE sites SET brief_json = 'not json' WHERE id = ?").bind(site.siteId).run();
    const res = await h.call("GET", `/api/admin/versions/${site.versionId}`);
    expect(res.status).toBe(200);
    const detail = await json<AdminVersionDetail>(res);
    expect((detail.document as { copy: { heroHeadline: string } }).copy.heroHeadline).toBe("Call 555 today");
    expect(detail.checks.reviewsAttested).toBe(false);
  });

  it("approves only the exact bytes that were reviewed, then emails the owner", async () => {
    const site = await h.pendingSite();
    const wrong = await h.call("POST", `/api/admin/versions/${site.versionId}/approve`, { body: { htmlSha256: "0".repeat(64) } });
    expect(wrong.status).toBe(500);
    expect((await json<ErrorJson>(wrong)).error.code).toBe("internal");

    const ok = await h.call("POST", `/api/admin/versions/${site.versionId}/approve`, { body: { htmlSha256: site.htmlSha256, note: "Looks good", indexable: false } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ siteId: site.siteId, liveUrl: `https://${site.slug}.localhost:8789/` });
    expect(await (await (await h.r2("LIVE")).get(`${site.slug}.html`))?.text()).toContain("Call Joe today");
    const row = await (await h.db()).prepare("SELECT live_version_id, indexable FROM sites WHERE id = ?").bind(site.siteId).first<{ live_version_id: string; indexable: number }>();
    expect(row).toEqual({ live_version_id: site.versionId, indexable: 0 });
    expect((await h.outbox(site.email))[0]).toMatchObject({ subject: "Your website is live", tag: "review_result" });
  });

  // P4-23 item 4, option (a) (web-maker-f4, 2026-09-30): the approval is done before the owner's email is built, so
  // an email that cannot be built (reviewApprovedEmail refuses a live address that is not a safe https URL) skips
  // only the email; the admin gets the usual answer. Plan 2 builds the live address from ROOT_DOMAIN and the site's
  // stored slug, and a stored slug with a space in it gives an address the email refuses.
  it("keeps the approval and answers as usual when the owner email cannot be built", async () => {
    const site = await h.pendingSite();
    const slug = `${site.slug} x`;
    const db = await h.db();
    await db.prepare("UPDATE sites SET slug = ? WHERE id = ?").bind(slug, site.siteId).run();
    h.server.clearLogs();
    const res = await h.call("POST", `/api/admin/versions/${site.versionId}/approve`, { body: { htmlSha256: site.htmlSha256 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ siteId: site.siteId, liveUrl: `https://${slug}.localhost:8789/` });
    expect(await db.prepare("SELECT status FROM site_versions WHERE id = ?").bind(site.versionId).first()).toEqual({ status: "approved" });
    expect(await db.prepare("SELECT live_version_id, pending_version_id FROM sites WHERE id = ?").bind(site.siteId).first()).toEqual({
      live_version_id: site.versionId,
      pending_version_id: null,
    });
    expect(await (await (await h.r2("LIVE")).get(`${slug}.html`))?.text()).toContain("Call Joe today");
    expect((await db.prepare("SELECT action FROM audit_log WHERE site_id = ? ORDER BY id").bind(site.siteId).all()).results).toEqual([
      { action: "version.requested" },
      { action: "version.approved" },
    ]);
    // One line says the email was skipped, with ids and a reason code only; the request's own line follows.
    expect(h.logLines()).toEqual([
      { event: "owner_email_skipped", reason: "invalid_live_url", versionId: site.versionId, siteId: site.siteId },
      { route: "POST /api/admin/versions/:versionId/approve", status: 200, ms: expect.any(Number) },
    ]);
    const raw = h.server.getLogs().map((entry) => entry.message).join("\n");
    expect(raw).not.toContain(site.slug);
    expect(raw).not.toContain(site.email);
    expect(await h.outbox(site.email)).toEqual([]);
  });

  it("rejects with a note that is emailed to the owner", async () => {
    const site = await h.pendingSite();
    expect((await h.call("POST", `/api/admin/versions/${site.versionId}/reject`, { body: { note: "" } })).status).toBe(422);
    const res = await h.call("POST", `/api/admin/versions/${site.versionId}/reject`, { body: { note: "Please use your own photos." } });
    expect(await res.json()).toEqual({ siteId: site.siteId });
    const [email] = await h.outbox(site.email);
    expect(email).toMatchObject({ subject: "Your website needs a change before it goes live" });
    expect(email?.text).toContain("Please use your own photos.");
    const again = await h.call("POST", `/api/admin/versions/${site.versionId}/reject`, { body: { note: "x" } });
    expect(again.status).toBe(409);
  });
});

// P4-18b (web-maker-d3, 2026-09-30): the admin SPA FETCHES the stored page (same-origin, cors, empty) and
// shows its bytes in <iframe sandbox srcdoc>; no frame ever navigates to /api/admin/*. A browser sends no
// Origin on a GET fetch like this one, so neither request below carries one.
describe("the stored page behind the Fetch Metadata gate", () => {
  const fetchFrom = (site: string) => ({ origin: null, headers: { "Sec-Fetch-Site": site, "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" } });

  it("answers the admin SPA's same-origin fetch with the stored bytes and the review page headers", async () => {
    const site = await h.pendingSite();
    const res = await h.call("GET", `/api/admin/versions/${site.versionId}/page`, fetchFrom("same-origin"));
    expect(res.status).toBe(200);
    const stored = await (await (await h.r2("WORK")).get(versionKey(site.siteId, site.versionId)))?.text();
    expect(stored).toContain("Call Joe today");
    expect(await res.text()).toBe(stored);
    const { ROOT_DOMAIN } = (await h.server.getWorker().getEnv()) as { ROOT_DOMAIN: string };
    for (const [name, value] of Object.entries(reviewPageHeaders(ROOT_DOMAIN))) expect(res.headers.get(name), name).toBe(value);
  });

  it("refuses the same fetch from another site", async () => {
    const site = await h.pendingSite();
    const res = await h.call("GET", `/api/admin/versions/${site.versionId}/page`, fetchFrom("cross-site"));
    expect(res.status).toBe(403);
    expect(await json<ErrorJson>(res)).toEqual({ error: { code: "forbidden", message: "This request is not allowed from another site" } });
  });
});

// The queue's own query (web-maker-d3, 2026-09-30): only the columns it shows, oldest first with the id breaking a
// tie, at most 50. Keep this block last in the file: its last test leaves more than 50 versions waiting.
describe("the review queue", () => {
  const queue = async () => (await json<{ items: Array<{ version: { id: string } }> }>(await h.call("GET", "/api/admin/reviews"))).items.map((item) => item.version.id);

  it("reads only the columns it shows, never brief_json, document_json or edits_json", async () => {
    expect(REVIEW_QUEUE).not.toMatch(/brief_json|document_json|edits_json|\*/);
    const site = await h.pendingSite();
    const { results } = await (await h.db()).prepare(REVIEW_QUEUE).bind().all();
    expect(Object.keys(results.find((row) => row["v_id"] === site.versionId) ?? {}).sort()).toEqual(
      [
        "v_id",
        "v_number",
        "v_status",
        "v_requested_at",
        "v_reviewed_at",
        "v_review_note",
        "id",
        "owner_id",
        "slug",
        "facts_json",
        "live_version_id",
        "pending_version_id",
        "indexable",
        "taken_down_at",
        "created_at",
        "updated_at",
        "owner_email",
        "owner_disabled_at",
      ].sort(),
    );
  });

  it("lists versions requested in the same millisecond by id", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) ids.push((await h.pendingSite()).versionId);
    await (await h.db())
      .prepare(`UPDATE site_versions SET requested_at = 1 WHERE id IN (${ids.map(() => "?").join(", ")})`)
      .bind(...ids)
      .run();
    expect((await queue()).slice(0, 8)).toEqual([...ids].sort());
  });

  it("lists at most 50 versions, so the newest waits its turn", async () => {
    const db = await h.db();
    const waiting = async () => (await db.prepare("SELECT COUNT(*) AS n FROM site_versions WHERE status = 'pending'").bind().first<{ n: number }>())?.n ?? 0;
    while ((await waiting()) < 50) await h.pendingSite();
    const newest = await h.pendingSite();
    const listed = await queue();
    expect(listed).toHaveLength(50);
    expect(listed).not.toContain(newest.versionId);
  });
});
