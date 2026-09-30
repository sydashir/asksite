import { reviewPageHeaders } from "@asksite/app-common";
import { versionKey, type AdminVersionDetail } from "@asksite/core";
import { describe, expect, it } from "vitest";
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
