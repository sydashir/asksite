import { reviewPageHeaders } from "@asksite/app-common";
import { livePageKey, livePointerKey, newId, pagesDigest, versionPageKey, type AdminVersionDetail } from "@asksite/core";
import { PAGE_IDS, PAGES, type PageId } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { REVIEW_QUEUE } from "../../src/worker/queries.ts";
import { json, useAdminHarness, VALID_FACTS } from "../support/harness.ts";

const h = useAdminHarness();

type ErrorJson = { error: { code: string; message: string } };

/** The pages the version's row lists, with their hashes (what the detail must show). */
async function listedPages(versionId: string): Promise<Array<{ page: PageId; sha256: string }>> {
  const row = await (await h.db()).prepare("SELECT pages_json FROM site_versions WHERE id = ?").bind(versionId).first<{ pages_json: string }>();
  return JSON.parse(row?.pages_json ?? "[]") as Array<{ page: PageId; sha256: string }>;
}

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
    // Every page the version has, in page order, with its label, its own address and the hash the admin's browser checks it against;
    // the digest of those hashes is the htmlSha256 that Approve sends back.
    const listed = await listedPages(site.versionId);
    expect(listed.map((p) => p.page)).toEqual(["home", "services", "about", "contact"]);
    expect(detail.pages).toEqual(listed.map(({ page, sha256 }) => ({ page, label: PAGES[page].label, url: `/api/admin/versions/${site.versionId}/pages/${page}`, sha256 })));
    expect(await pagesDigest(listed as Parameters<typeof pagesDigest>[0])).toBe(detail.version.htmlSha256);
    expect(detail).not.toHaveProperty("pageUrl");
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

  // The checks the test above sees only at their defaults, here set away from them (task review I1, 2026-09-30); the
  // next test does firstPublish and the live document. The slug's flags are the reviewer's only brand and profanity
  // signal for a web address (decision 4), so a check that went quiet must fail a test.
  it("shows the slug flags, social link hosts, photo count and fallback copy in the checks", async () => {
    const photo = (name: string) => ({ url: `https://media.localhost:8789/a/${name}.webp`, alt: "A new water heater", width: 400, height: 300 });
    const facts = {
      ...VALID_FACTS,
      heroPhoto: photo("hero"),
      photos: [photo("one"), photo("two")],
      socialLinks: [
        { network: "facebook", url: "https://www.facebook.com/joesplumbing" },
        { network: "google", url: "https://maps.app.goo.gl/joes" },
      ],
    };
    const site = await h.pendingSite(facts);
    const db = await h.db();
    await db.prepare("UPDATE sites SET slug = 'paypal-refund-help' WHERE id = ?").bind(site.siteId).run();
    await db.prepare("UPDATE generations SET used_fallback = 1 WHERE id = (SELECT generation_id FROM site_versions WHERE id = ?)").bind(site.versionId).run();
    const detail = await json<AdminVersionDetail>(await h.call("GET", `/api/admin/versions/${site.versionId}`));
    expect(detail.checks).toEqual({
      firstPublish: true,
      testimonials: 0,
      reviewsAttested: false,
      hiddenSections: ["faq"],
      socialHosts: ["www.facebook.com", "maps.app.goo.gl"],
      photoCount: 3,
      usedFallbackCopy: true,
      slugFlags: ["brand:paypal", "word:refund"],
      textFlags: [],
    });
  });

  // A new version of a live site: not a first publish, and the live document comes with it for the text diff. The
  // new version is added straight to the table as a copy of the live row with new wording (the detail reads only
  // its document, never its page).
  it("shows a live site's new version next to the live document", async () => {
    const site = await h.pendingSite();
    expect((await h.call("POST", `/api/admin/versions/${site.versionId}/approve`, { body: { htmlSha256: site.htmlSha256 } })).status).toBe(200);
    const db = await h.db();
    const live = await db.prepare("SELECT document_json FROM site_versions WHERE id = ?").bind(site.versionId).first<{ document_json: string }>();
    const document = JSON.parse(live?.document_json ?? "{}") as { copy: Record<string, unknown> };
    document.copy["ctaText"] = "Book Joe now";
    const next = newId();
    await db
      .prepare(
        `INSERT INTO site_versions (id, site_id, number, status, document_json, document_sha256, edits_json, generation_id,
           pages_json, html_key, html_sha256, stylesheet_sha256, requested_by, requested_at)
         SELECT ?, site_id, 2, 'pending', ?, document_sha256, edits_json, generation_id,
           pages_json, html_key, html_sha256, stylesheet_sha256, requested_by, requested_at + 1
         FROM site_versions WHERE id = ?`,
      )
      .bind(next, JSON.stringify(document), site.versionId)
      .run();
    await db.prepare("UPDATE sites SET pending_version_id = ? WHERE id = ?").bind(next, site.siteId).run();
    const detail = await json<AdminVersionDetail>(await h.call("GET", `/api/admin/versions/${next}`));
    expect(detail.version).toMatchObject({ id: next, number: 2, status: "pending" });
    expect(detail.checks.firstPublish).toBe(false);
    expect(detail.document).toMatchObject({ copy: { ctaText: "Book Joe now" } });
    expect(detail.liveDocument).toMatchObject({ copy: { ctaText: "Call Joe today" } });
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
    // Every page at its own immutable key, and one pointer (the slug itself, an empty object) naming the live version and the business.
    const live = await h.r2("LIVE");
    const pages = await listedPages(site.versionId);
    expect(await h.liveKeys(site.slug)).toEqual([livePointerKey(site.slug), ...pages.map(({ page }) => livePageKey(site.slug, site.versionId, page))].sort());
    expect(await (await live.get(livePageKey(site.slug, site.versionId, "home")))?.text()).toContain("Call Joe today");
    const pointer = await live.get(livePointerKey(site.slug));
    expect(await pointer?.text()).toBe("");
    expect(pointer?.customMetadata).toEqual({ siteId: site.siteId, versionId: site.versionId, businessName: "Joe's Plumbing", phoneText: "(512) 555-0142", phoneTel: "+15125550142" });
    const row = await (await h.db()).prepare("SELECT live_version_id, indexable FROM sites WHERE id = ?").bind(site.siteId).first<{ live_version_id: string; indexable: number }>();
    expect(row).toEqual({ live_version_id: site.versionId, indexable: 0 });
    expect((await h.outbox(site.email))[0]).toMatchObject({ subject: "Your website is live", tag: "review_result" });
  });

  // Security review I1 (web-maker-f4, 2026-09-30): Plan 2's approveVersion commits its D1 batch and only then copies
  // the page to LIVE, so the route hands the approval to waitUntil (runToEnd) and an admin's dropped connection
  // cannot stop it between the two. A refused approve (nothing goes live, no email) hands over that one promise; an
  // approval hands over two, the approval and the owner's email.
  it("hands the approval to waitUntil as well, so a client that goes away cannot stop it halfway", async () => {
    const site = await h.pendingSite();
    const path = `/api/admin/versions/${site.versionId}/approve`;
    const handedOver = async (body: { htmlSha256: string }) => {
      const before = await h.waitUntilCount(path);
      const { status } = await h.call("POST", path, { body });
      return { status, waitUntil: (await h.waitUntilCount(path)) - before };
    };
    const refused = await handedOver({ htmlSha256: "0".repeat(64) });
    const approved = await handedOver({ htmlSha256: site.htmlSha256 });
    expect({ refused, approved }).toEqual({ refused: { status: 500, waitUntil: 1 }, approved: { status: 200, waitUntil: 2 } });
    await h.backgroundDone(path);
  });

  // A16: the approval is recorded and then the LIVE pointer is written; if that write fails the site answers 503 until
  // Approve is pressed again, which finishes it and leaves exactly one audit row.
  it("answers live_copy_failed when the pointer write fails after the approval, and approving again finishes it with one audit row", async () => {
    const site = await h.pendingSite();
    const approve = (headers?: Record<string, string>) =>
      h.call("POST", `/api/admin/versions/${site.versionId}/approve`, { body: { htmlSha256: site.htmlSha256 }, ...(headers === undefined ? {} : { headers }) });
    const failed = await approve({ "X-Test-Takedown-Fault": "pointer-write" });
    expect(failed.status).toBe(500);
    expect(await json<ErrorJson>(failed)).toEqual({ error: { code: "internal", message: "Approved, but the new pages are not live yet. Press Approve again." } });
    const db = await h.db();
    // The approval is in D1, the pages are copied, and no pointer exists: no visitor sees anything yet.
    expect(await db.prepare("SELECT status FROM site_versions WHERE id = ?").bind(site.versionId).first()).toEqual({ status: "approved" });
    expect(await db.prepare("SELECT live_version_id FROM sites WHERE id = ?").bind(site.siteId).first()).toEqual({ live_version_id: site.versionId });
    expect(await h.liveKeys(site.slug)).not.toContain(livePointerKey(site.slug));
    expect((await h.liveKeys(site.slug)).length).toBeGreaterThan(0);

    const healed = await approve();
    expect(healed.status).toBe(200);
    expect(await h.liveKeys(site.slug)).toContain(livePointerKey(site.slug));
    expect((await (await h.r2("LIVE")).get(livePointerKey(site.slug)))?.customMetadata?.["versionId"]).toBe(site.versionId);
    const audits = await db.prepare("SELECT action FROM audit_log WHERE site_id = ? AND action = 'version.approved'").bind(site.siteId).all();
    expect(audits.results).toHaveLength(1);
  });

  // A16-4c, 23-A16 round 1 (I1): approve runs under the site's lease, and its answers carry PublishError.detail.
  it("approve on a site another admin action holds is 409 with Retry-After and the busy text, and changes nothing", async () => {
    const site = await h.pendingSite();
    const db = await h.db();
    await db.prepare("UPDATE sites SET admin_lock = 'someone-else', admin_lock_until = ? WHERE id = ?").bind(Date.now() + 60_000, site.siteId).run();
    const res = await h.call("POST", `/api/admin/versions/${site.versionId}/approve`, { body: { htmlSha256: site.htmlSha256 } });
    expect(res.status).toBe(409);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await json<ErrorJson>(res)).toMatchObject({ error: { code: "conflict", message: "Another admin action on this site is still running. Try again in a minute." } });
    expect(await db.prepare("SELECT status FROM site_versions WHERE id = ?").bind(site.versionId).first()).toEqual({ status: "pending" });
    expect(await h.liveKeys(site.slug)).toEqual([]);
    expect((await db.prepare("SELECT admin_lock FROM sites WHERE id = ?").bind(site.siteId).first<{ admin_lock: string }>())?.admin_lock).toBe("someone-else");
  });

  it("approve that loses its lease after the approval committed answers the lease-lost text with NO Retry-After; D1 is live, no pointer, and approving again finishes it", async () => {
    const site = await h.pendingSite();
    const approve = (headers?: Record<string, string>) =>
      h.call("POST", `/api/admin/versions/${site.versionId}/approve`, { body: { htmlSha256: site.htmlSha256 }, ...(headers === undefined ? {} : { headers }) });
    const lost = await approve({ "X-Test-Takedown-Fault": "lease-lost-after-batch" });
    expect(lost.status).toBe(409);
    expect(lost.headers.get("Retry-After")).toBeNull();
    expect(await json<ErrorJson>(lost)).toEqual({
      error: { code: "conflict", message: "This approval ran too long and was stopped before it finished. Press Approve again to finish it and tell the owner." },
    });
    const db = await h.db();
    expect(await db.prepare("SELECT status FROM site_versions WHERE id = ?").bind(site.versionId).first()).toEqual({ status: "approved" });
    expect(await db.prepare("SELECT live_version_id FROM sites WHERE id = ?").bind(site.siteId).first()).toEqual({ live_version_id: site.versionId });
    expect(await h.liveKeys(site.slug)).not.toContain(livePointerKey(site.slug));
    expect((await approve()).status).toBe(200);
    expect(await h.liveKeys(site.slug)).toContain(livePointerKey(site.slug));
  });

  // P4-23 item 4, option (a) (web-maker-f4, 2026-09-30): the approval is done before the owner's email is built, so
  // an email that cannot be built (reviewApprovedEmail refuses a live address that is not a safe https URL) skips
  // only the email; the admin gets the usual answer. Plan 2 builds the live address from ROOT_DOMAIN and the site's slug, and
  // since A16 its keys refuse a malformed slug (the approval then fails before it changes anything), so this test Worker
  // has the fake approve answer an address the email refuses (X-Test-Unsafe-Live-Url) instead of a bad slug.
  it("keeps the approval and answers as usual when the owner email cannot be built", async () => {
    const site = await h.pendingSite();
    const db = await h.db();
    h.server.clearLogs();
    const res = await h.call("POST", `/api/admin/versions/${site.versionId}/approve`, { body: { htmlSha256: site.htmlSha256 }, headers: { "X-Test-Unsafe-Live-Url": "1" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ siteId: site.siteId, liveUrl: "http://unsafe.example/" });
    expect(await db.prepare("SELECT status FROM site_versions WHERE id = ?").bind(site.versionId).first()).toEqual({ status: "approved" });
    expect(await db.prepare("SELECT live_version_id, pending_version_id FROM sites WHERE id = ?").bind(site.siteId).first()).toEqual({
      live_version_id: site.versionId,
      pending_version_id: null,
    });
    expect(await (await (await h.r2("LIVE")).get(livePageKey(site.slug, site.versionId, "home")))?.text()).toContain("Call Joe today");
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

// P4-18b (web-maker-d3, 2026-09-30): the admin SPA FETCHES a stored page (same-origin, cors, empty) and
// shows its bytes in <iframe sandbox srcdoc>; no frame ever navigates to /api/admin/*. A browser sends no
// Origin on a GET fetch like this one, so neither request below carries one.
describe("a stored page behind the Fetch Metadata gate (A16: one route per page)", () => {
  const fetchFrom = (site: string) => ({ origin: null, headers: { "Sec-Fetch-Site": site, "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" } });
  const pageUrl = (versionId: string, page: string) => `/api/admin/versions/${versionId}/pages/${page}`;

  it("answers the admin SPA's same-origin fetch with each page's stored bytes and the review page headers (framable only by the admin origin)", async () => {
    const site = await h.pendingSite();
    const { ROOT_DOMAIN } = (await h.server.getWorker().getEnv()) as { ROOT_DOMAIN: string };
    const listed = await listedPages(site.versionId);
    expect(listed.length).toBeGreaterThan(1);
    const bodies = new Set<string>();
    for (const { page } of listed) {
      const res = await h.call("GET", pageUrl(site.versionId, page), fetchFrom("same-origin"));
      expect([page, res.status]).toEqual([page, 200]);
      const stored = await (await (await h.r2("WORK")).get(versionPageKey(site.siteId, site.versionId, page)))?.text();
      const body = await res.text();
      expect(body).toBe(stored);
      bodies.add(body);
      for (const [name, value] of Object.entries(reviewPageHeaders(ROOT_DOMAIN))) expect(res.headers.get(name), name).toBe(value);
      expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
      expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'self'");
    }
    expect(bodies.size).toBe(listed.length);
    expect([...bodies].some((html) => html.includes("Call Joe today"))).toBe(true);
  });

  it("refuses the same fetch from another site", async () => {
    const site = await h.pendingSite();
    for (const page of ["home", "contact"]) {
      const res = await h.call("GET", pageUrl(site.versionId, page), fetchFrom("cross-site"));
      expect(res.status).toBe(403);
      expect(await json<ErrorJson>(res)).toEqual({ error: { code: "forbidden", message: "This request is not allowed from another site" } });
    }
  });

  // The page-id parameter (STRICT: an unlisted page or a key built from a request must never be served).
  it("answers 404 for an id that is not one of the five pages, including look-alikes and traversal", async () => {
    const site = await h.pendingSite();
    for (const id of ["nope", "Home", "HOME", "home.html", "__proto__", "constructor", "toString", "..%2Fhome", "%2e%2e%2fhome", "home%00", "home%2F..%2Fabout"]) {
      const res = await h.call("GET", pageUrl(site.versionId, id), fetchFrom("same-origin"));
      expect([id, res.status]).toEqual([id, 404]);
      expect([id, (await json<ErrorJson>(res)).error.code]).toEqual([id, "not_found"]);
    }
  });

  it("answers 404 for a page the version lacks, even when an object sits at that page's key", async () => {
    const site = await h.pendingSite();
    const listed = (await listedPages(site.versionId)).map((p) => p.page);
    expect(PAGE_IDS.filter((id) => !listed.includes(id))).toEqual(["gallery"]);
    await (await h.r2("WORK")).put(versionPageKey(site.siteId, site.versionId, "gallery"), "<p>not part of this version</p>");
    const res = await h.call("GET", pageUrl(site.versionId, "gallery"), fetchFrom("same-origin"));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("not part of this version");
  });

  it("answers 404 for every page of a version that lists none (a row from before A16), and lists no pages in its detail", async () => {
    const site = await h.pendingSite();
    await (await h.db()).prepare("UPDATE site_versions SET pages_json = '[]' WHERE id = ?").bind(site.versionId).run();
    await (await h.r2("WORK")).put(versionPageKey(site.siteId, site.versionId, "gallery"), "<p>stray</p>");
    for (const page of PAGE_IDS) expect([page, (await h.call("GET", pageUrl(site.versionId, page), fetchFrom("same-origin"))).status]).toEqual([page, 404]);
    const detail = await json<AdminVersionDetail>(await h.call("GET", `/api/admin/versions/${site.versionId}`));
    expect(detail.pages).toEqual([]);
  });

  it("answers 404 for a version that does not exist, and no longer serves the old single-page address", async () => {
    const site = await h.pendingSite();
    expect((await h.call("GET", pageUrl(newId(), "home"), fetchFrom("same-origin"))).status).toBe(404);
    expect((await h.call("GET", `/api/admin/versions/${site.versionId}/page`, fetchFrom("same-origin"))).status).toBe(404);
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
