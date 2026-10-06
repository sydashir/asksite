import { livePageKey, livePointerKey, mediaKey, newId } from "@asksite/core";
import { PAGE_IDS, PAGES, type PageId } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { at, BUSINESS_METADATA, PHONE_METADATA, putLive, putPointer, ROOT, seedSite, seedUpload, sitesHarness, type ToolsEnv } from "./support/harness.ts";

const harness = sitesHarness();
let tools: ToolsEnv;
beforeAll(async () => {
  ({ tools } = await harness.start());
}, 120_000);
afterAll(async () => {
  await harness.server.close();
});

// Request and response types come from the harness (Miniflare), not the Workers runtime types.
type Init = NonNullable<Parameters<typeof harness.server.fetch>[1]>;
type HarnessResponse = Awaited<ReturnType<typeof harness.server.fetch>>;
const get = (url: string, init: Init = {}): Promise<HarnessResponse> => harness.server.fetch(url, { redirect: "manual", ...init });
const CSP = `default-src 'none'; style-src 'unsafe-inline'; img-src https://media.${ROOT}; font-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

describe("live pages", () => {
  it("serves the approved bytes with the page headers and no noindex", async () => {
    const site = await seedSite(tools);
    const response = await get(at(site.slug));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(site.html);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache", // browsers revalidate every view (U2); the edge keeps its own copy
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
    });
    expect(response.headers.get("x-robots-tag")).toBeNull();
  });

  it("ignores the query string", async () => {
    const site = await seedSite(tools);
    expect(await (await get(at(site.slug, "/?utm_source=x"))).text()).toBe(site.html);
  });

  it("adds noindex when the admin switched search engines off", async () => {
    const site = await seedSite(tools, { indexable: false });
    const response = await get(at(site.slug));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("D1 decides: a site that is not live gets 404 even when a pointer and a page exist", async () => {
    const draft = await seedSite(tools, { live: false, withObject: true });
    expect((await get(at(draft.slug))).status).toBe(404);
    const takenDown = await seedSite(tools, { takenDown: true });
    const response = await get(at(takenDown.slug));
    expect(response.status).toBe(404);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("returns 404 without caching while the pointer is still missing, and 503 while it names a page that is not there yet", async () => {
    const site = await seedSite(tools, { withObject: false });
    expect((await get(at(site.slug))).status).toBe(404);
    await putPointer(tools, site);
    expect((await get(at(site.slug))).status).toBe(503); // a pointer without its Home page is a broken state
    await putLive(tools, site);
    expect((await get(at(site.slug))).status).toBe(200);
  });

  it("never asks D1 about a slug with no pointer: with D1's sites table gone it is still 404, not 503", async () => {
    await tools.DB.prepare("ALTER TABLE sites RENAME TO sites_offline").run();
    try {
      expect((await get(at("no-such-shop"))).status).toBe(404);
    } finally {
      await tools.DB.prepare("ALTER TABLE sites_offline RENAME TO sites").run();
    }
  });

  it("answers 503, uncached, while the pointer names another version than the one D1 says is live", async () => {
    const site = await seedSite(tools);
    const other = { ...site, versionId: newId(), html: "<!DOCTYPE html><p>an older version</p>" };
    await putLive(tools, other);
    await putPointer(tools, other);
    const stale = await get(at(site.slug));
    expect(stale.status).toBe(503);
    expect(stale.headers.get("retry-after")).toBe("60");
    expect(stale.headers.get("x-robots-tag")).toBe("noindex");
    await putPointer(tools, site);
    expect(await (await get(at(site.slug))).text()).toBe(site.html);
  });

  it("answers 503, and reads no page, when the pointer's version is not an id", async () => {
    const site = await seedSite(tools);
    for (const versionId of ["", "../x", "not-an-id", `${site.versionId}/../other`, String(site.versionId).toUpperCase()]) {
      await putPointer(tools, site, {}, versionId);
      const response = await get(at(site.slug));
      expect(response.status, versionId).toBe(503);
      expect(response.headers.get("x-robots-tag"), versionId).toBe("noindex");
    }
    await tools.LIVE.put(livePointerKey(site.slug), "", { customMetadata: { siteId: site.siteId } }); // no versionId at all
    expect((await get(at(site.slug))).status).toBe(503);
  });

  it("keeps a served page in this data centre's cache for its 60 s TTL", async () => {
    const site = await seedSite(tools);
    expect((await get(at(site.slug))).status).toBe(200);
    await tools.DB.prepare("UPDATE sites SET taken_down_at = 99 WHERE id = ?").bind(site.siteId).run();
    await tools.LIVE.delete(livePageKey(site.slug, String(site.versionId), "home"));
    const cached = await get(at(site.slug));
    expect(cached.status).toBe(200);
    expect(await cached.text()).toBe(site.html);
  });

  it("answers HEAD with the page headers and no body", async () => {
    const site = await seedSite(tools);
    const response = await get(at(site.slug), { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(CSP);
    expect(await response.text()).toBe("");
  });

  it("answers 503 with Retry-After when D1 fails, and does not cache it", async () => {
    const site = await seedSite(tools);
    await tools.DB.prepare("ALTER TABLE sites RENAME TO sites_offline").run();
    try {
      const response = await get(at(site.slug));
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(response.headers.get("x-robots-tag")).toBe("noindex");
    } finally {
      await tools.DB.prepare("ALTER TABLE sites_offline RENAME TO sites").run();
    }
    expect((await get(at(site.slug))).status).toBe(200);
  });
});

// A16: a site has up to 5 pages, each its own LIVE object under the pointer's version. Each page is cached on its own.
describe("a site's pages", () => {
  const PAGE_NAMES = PAGE_IDS.filter((page) => page !== "home");
  const pageHtml = (site: { slug: string }, page: PageId) => `<!DOCTYPE html><html lang="en"><head><title>${site.slug} ${page}</title></head><body><main><h1>${page}</h1></main></body></html>`;

  async function seedPages(options: Parameters<typeof seedSite>[1] = {}, only: readonly PageId[] = PAGE_IDS) {
    const site = await seedSite(tools, { metadata: BUSINESS_METADATA, ...options });
    for (const page of only) await putLive(tools, { ...site, html: pageHtml(site, page) }, page);
    return site;
  }

  it("serves each of the 5 pages with its own bytes and the live headers, to GET and HEAD", async () => {
    const site = await seedPages();
    for (const page of PAGE_IDS) {
      const url = at(site.slug, PAGES[page].path);
      const response = await get(url);
      expect(response.status, page).toBe(200);
      expect(await response.text(), page).toBe(pageHtml(site, page));
      expect(Object.fromEntries(response.headers), page).toMatchObject({ "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "content-security-policy": CSP });
      expect(response.headers.get("x-robots-tag"), page).toBeNull();
      const head = await get(url, { method: "HEAD" });
      expect(head.status, page).toBe(200);
      expect(head.headers.get("content-security-policy"), page).toBe(CSP);
      expect(await head.text(), page).toBe("");
    }
  });

  it("ignores the query string on a page", async () => {
    const site = await seedPages();
    expect(await (await get(at(site.slug, "/services?x=1"))).text()).toBe(pageHtml(site, "services"));
  });

  it("keeps each page in its own cache entry for 60 s", async () => {
    const site = await seedPages();
    expect((await get(at(site.slug, "/services"))).status).toBe(200);
    await tools.LIVE.delete(livePageKey(site.slug, String(site.versionId), "services"));
    const cached = await get(at(site.slug, "/services"));
    expect(cached.status).toBe(200);
    expect(await cached.text()).toBe(pageHtml(site, "services"));
    // Services' entry is not About's: About was never fetched, so its deleted object is a miss.
    await tools.LIVE.delete(livePageKey(site.slug, String(site.versionId), "about"));
    expect((await get(at(site.slug, "/about"))).status).toBe(404);
  });

  it("answers the named 404 that links Home for a missing optional page, and caches it for this version for 60 s", async () => {
    const site = await seedPages({}, ["home", "services", "contact"]);
    const response = await get(at(site.slug, "/gallery"));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain('<p><a href="/">Go to Reliable Rooter Plumbing\'s page</a></p>');
    // A version's pages never change, so the 404 stays (named again from the pointer, uncached for browsers) until its 60 s are over.
    await putLive(tools, { ...site, html: pageHtml(site, "gallery") }, "gallery");
    const again = await get(at(site.slug, "/gallery"));
    expect(again.status).toBe(404);
    expect(again.headers.get("cache-control")).toBe("no-store");
    expect(await again.text()).toContain("Go to Reliable Rooter Plumbing's page");
    expect((await get(at(site.slug, "/services"))).status).toBe(200); // another page of the version is not in that entry
  });

  it("answers 503, uncached, for every page while the pointer names a version that is not D1's live one", async () => {
    const site = await seedPages();
    const other = { ...site, versionId: newId() };
    for (const page of PAGE_IDS) await putLive(tools, { ...other, html: "<p>older</p>" }, page);
    await putPointer(tools, other, BUSINESS_METADATA);
    for (const page of PAGE_IDS) {
      const stale = await get(at(site.slug, PAGES[page].path));
      expect(stale.status, page).toBe(503);
      expect(stale.headers.get("retry-after"), page).toBe("60");
    }
  });

  it("answers 404 on every page once the site is taken down", async () => {
    const site = await seedPages();
    await tools.DB.prepare("UPDATE sites SET taken_down_at = 99 WHERE id = ?").bind(site.siteId).run();
    for (const page of PAGE_IDS) expect((await get(at(site.slug, PAGES[page].path))).status, page).toBe(404);
  });

  // Decision 24's costs: a missing optional page is one pointer head and one page get, a wrong path one head.
  it("answers the pages of a site with no D1 at all only from LIVE, until a page really exists", async () => {
    const site = await seedPages({}, ["home", "services", "contact"]);
    await tools.DB.prepare("ALTER TABLE sites RENAME TO sites_offline").run();
    try {
      expect((await get(at(site.slug, "/gallery"))).status).toBe(404); // a missing optional page needs no D1
      expect((await get(at(site.slug, "/about"))).status).toBe(404);
    } finally {
      await tools.DB.prepare("ALTER TABLE sites_offline RENAME TO sites").run();
    }
  });

  it("redirects a trailing slash on a page path to the page, with no R2 or D1 read", async () => {
    const site = await seedPages();
    await tools.DB.prepare("ALTER TABLE sites RENAME TO sites_offline").run();
    try {
      for (const page of PAGE_NAMES) {
        for (const method of ["GET", "HEAD"]) {
          const response = await get(at(site.slug, `${PAGES[page].path}/?x=1`), { method });
          expect(response.status, page).toBe(301);
          expect(response.headers.get("location"), page).toBe(`${at(site.slug, PAGES[page].path)}?x=1`);
          expect(response.headers.get("cache-control"), page).toBe("no-store");
        }
      }
    } finally {
      await tools.DB.prepare("ALTER TABLE sites_offline RENAME TO sites").run();
    }
  });

  it("never asks D1 about an unknown slug on any page path", async () => {
    await tools.DB.prepare("ALTER TABLE sites RENAME TO sites_offline").run();
    try {
      for (const page of PAGE_IDS) expect((await get(at("no-such-shop", PAGES[page].path))).status, page).toBe(404);
    } finally {
      await tools.DB.prepare("ALTER TABLE sites_offline RENAME TO sites").run();
    }
  });
});

// U2 (user, 2026-10-01): all pages of a site switch to a new version together, and no visitor sees pages of two
// versions, caches included. The pointer names the live version and every cache key carries the version id.
describe("one version at a time (U2)", () => {
  const html = (version: string, page: PageId) => `<!DOCTYPE html><html lang="en"><body><main><h1>${version} ${page}</h1></main></body></html>`;

  /** A live site whose pages are all v1's, every page fetched once (so every page is in the data centre's cache). */
  async function cachedV1() {
    const site = await seedSite(tools, { metadata: BUSINESS_METADATA });
    for (const page of PAGE_IDS) await putLive(tools, { ...site, html: html("v1", page) }, page);
    for (const page of PAGE_IDS) expect(await (await get(at(site.slug, PAGES[page].path))).text(), page).toBe(html("v1", page));
    return site;
  }

  /** What approveVersion does: the pages at the new version's keys, then D1, then the pointer. */
  async function approveV2(site: Awaited<ReturnType<typeof cachedV1>>) {
    const v2 = newId();
    for (const page of PAGE_IDS) await putLive(tools, { ...site, versionId: v2, html: html("v2", page) }, page);
    await tools.DB.prepare("UPDATE sites SET live_version_id = ? WHERE id = ?").bind(v2, site.siteId).run();
    await putPointer(tools, { ...site, versionId: v2 }, BUSINESS_METADATA);
    return v2;
  }

  it("a pointer write to v2 switches every page at once, the ones cached under v1 included", async () => {
    const site = await cachedV1();
    await approveV2(site);
    for (const round of [1, 2]) {
      for (const page of PAGE_IDS) {
        const response = await get(at(site.slug, PAGES[page].path));
        const body = await response.text();
        expect(response.status, `${round} ${page}`).toBe(200);
        expect(body, `${round} ${page}`).toBe(html("v2", page));
        expect(body, `${round} ${page}`).not.toContain("v1");
      }
    }
  });

  it("answers 404 on every page, cached or not, once the pointer is deleted", async () => {
    const site = await cachedV1();
    await tools.LIVE.delete(livePointerKey(site.slug));
    for (const page of PAGE_IDS) {
      const response = await get(at(site.slug, PAGES[page].path));
      expect(response.status, page).toBe(404);
      expect(response.headers.get("x-robots-tag"), page).toBe("noindex");
    }
  });

  it("answers browsers with no-cache, on a fill and on a cache hit", async () => {
    const site = await seedSite(tools);
    for (const round of ["fill", "hit"]) expect((await get(at(site.slug))).headers.get("cache-control"), round).toBe("no-cache");
  });

  it("never serves the version-scoped keys or the pointer as pages", async () => {
    const site = await seedSite(tools, { metadata: BUSINESS_METADATA });
    const version = String(site.versionId);
    for (const path of [`/${site.slug}`, `/${site.slug}/${version}/home.html`, `/__v/${version}/`, `/__v/${version}/services`]) {
      const response = await get(at(site.slug, path));
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toContain("Go to Reliable Rooter Plumbing");
    }
  });
});

describe("photos on media.<root>", () => {
  const media = (siteId: string, uploadId: string) => `https://media.${ROOT}/${siteId}/${uploadId}.webp`;

  it("serves the stored bytes as image/webp whatever R2 metadata says", async () => {
    const site = await seedSite(tools);
    const { uploadId, bytes } = await seedUpload(tools, site.siteId);
    const response = await get(media(site.siteId, uploadId));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "image/webp",
      "cache-control": "public, max-age=3600, s-maxage=60",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
      "cross-origin-resource-policy": "cross-origin",
      "x-robots-tag": "noindex",
    });
  });

  it("still serves a soft-deleted upload (a live version may show it)", async () => {
    const site = await seedSite(tools);
    const { uploadId } = await seedUpload(tools, site.siteId, { deleted: true });
    expect((await get(media(site.siteId, uploadId))).status).toBe(200);
  });

  it("stops serving a taken-down site's photos without deleting them", async () => {
    const site = await seedSite(tools, { takenDown: true });
    const { uploadId } = await seedUpload(tools, site.siteId);
    expect((await get(media(site.siteId, uploadId))).status).toBe(404);
    expect(await tools.MEDIA.get(mediaKey(site.siteId, uploadId))).not.toBeNull();
  });

  // D1 is asked before R2 (a taken-down site's photos must not cost an R2 read), so an id with no photo reaches D1 too.
  it("asks D1 before R2: with D1's uploads table gone even a photo that is not stored is 503, not 404", async () => {
    await tools.DB.prepare("ALTER TABLE uploads RENAME TO uploads_offline").run();
    try {
      expect((await get(media(newId(), newId()))).status).toBe(503);
    } finally {
      await tools.DB.prepare("ALTER TABLE uploads_offline RENAME TO uploads").run();
    }
  });

  it("keeps a taken-down site's photo 404 in this data centre's cache, so a restore shows it again within the TTL (60 s)", async () => {
    const site = await seedSite(tools, { takenDown: true });
    const { uploadId } = await seedUpload(tools, site.siteId);
    expect((await get(media(site.siteId, uploadId))).status).toBe(404);
    await tools.DB.prepare("UPDATE sites SET taken_down_at = NULL WHERE id = ?").bind(site.siteId).run();
    const cached = await get(media(site.siteId, uploadId));
    expect(cached.status).toBe(404); // the cached 404, until its 60 s are over
    expect(cached.headers.get("cache-control")).toBe("no-store");
    expect(cached.headers.get("age")).toBeNull();
  });

  it("refuses another site's id, unknown ids, bad paths and writes", async () => {
    const site = await seedSite(tools);
    const other = await seedSite(tools);
    const { uploadId } = await seedUpload(tools, site.siteId);
    expect((await get(media(other.siteId, uploadId))).status).toBe(404);
    expect((await get(media(site.siteId, "7c9e6679-7425-40de-944b-e07fc1f90ae7"))).status).toBe(404);
    expect((await get(`https://media.${ROOT}/${site.siteId}/${uploadId}.png`)).status).toBe(404);
    expect((await get(`https://media.${ROOT}/../${uploadId}.webp`)).status).toBe(404);
    expect((await get(media(site.siteId, uploadId), { method: "PUT", body: "x" })).status).toBe(404);
  });
});

// Pins beyond the brief: each test below fails on a code change that every test above lets through.
describe("pinned edges", () => {
  const media = (siteId: string, uploadId: string) => `https://media.${ROOT}/${siteId}/${uploadId}.webp`;

  it("serves a live site's page only at / and only to GET and HEAD", async () => {
    const site = await seedSite(tools);
    for (const path of ["/index.html", "/wp-admin", `/${site.slug}.html`]) {
      const response = await get(at(site.slug, path));
      expect(response.status, path).toBe(404);
      expect(response.headers.get("x-robots-tag"), path).toBe("noindex");
    }
    for (const method of ["POST", "PUT", "DELETE"]) expect((await get(at(site.slug), { method, body: "x" })).status, method).toBe(404);
  });

  it("does not cache the 404 of a taken-down site, so a restore is served at once", async () => {
    const site = await seedSite(tools, { takenDown: true });
    expect((await get(at(site.slug))).status).toBe(404);
    await tools.DB.prepare("UPDATE sites SET taken_down_at = NULL WHERE id = ?").bind(site.siteId).run();
    expect(await (await get(at(site.slug))).text()).toBe(site.html);
  });

  it("answers HEAD for a photo with the photo headers and no body", async () => {
    const site = await seedSite(tools);
    const { uploadId } = await seedUpload(tools, site.siteId);
    const response = await get(media(site.siteId, uploadId), { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(await response.text()).toBe("");
  });

  it("D1 decides a photo's site: an object stored under another site's id is not served", async () => {
    const site = await seedSite(tools);
    const other = await seedSite(tools);
    const { uploadId, bytes } = await seedUpload(tools, site.siteId);
    await tools.MEDIA.put(mediaKey(other.siteId, uploadId), bytes);
    expect((await get(media(other.siteId, uploadId))).status).toBe(404);
  });

  it("serves only lower-case v4 UUID ids, even when a row and an object exist under another spelling", async () => {
    const site = await seedSite(tools);
    const upper = newId().toUpperCase();
    await tools.DB.prepare("INSERT INTO uploads (id, site_id, width, height, bytes, created_at) VALUES (?, ?, 1600, 1200, 4, 1)").bind(upper, site.siteId).run();
    await tools.MEDIA.put(mediaKey(site.siteId, upper), new Uint8Array([1, 2, 3, 4]));
    expect((await get(media(site.siteId, upper))).status).toBe(404);
  });

  it("keeps a served photo in this data centre's cache", async () => {
    const site = await seedSite(tools);
    const { uploadId, bytes } = await seedUpload(tools, site.siteId);
    expect((await get(media(site.siteId, uploadId))).status).toBe(200);
    await tools.DB.prepare("UPDATE sites SET taken_down_at = 99 WHERE id = ?").bind(site.siteId).run();
    await tools.MEDIA.delete(mediaKey(site.siteId, uploadId));
    const cached = await get(media(site.siteId, uploadId));
    expect(cached.status).toBe(200);
    expect(new Uint8Array(await cached.arrayBuffer())).toEqual(bytes);
  });

  it("answers 503 with Retry-After when D1 fails for a stored photo, and does not cache it", async () => {
    const site = await seedSite(tools);
    const { uploadId } = await seedUpload(tools, site.siteId);
    await tools.DB.prepare("ALTER TABLE uploads RENAME TO uploads_offline").run();
    try {
      const response = await get(media(site.siteId, uploadId));
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(response.headers.get("x-robots-tag")).toBe("noindex");
    } finally {
      await tools.DB.prepare("ALTER TABLE uploads_offline RENAME TO uploads").run();
    }
    expect((await get(media(site.siteId, uploadId))).status).toBe(200);
  });
});

// QA-2 RU(3): a wrong or old address on a live site's host links to the site's page, named from the LIVE
// object's metadata alone. Hosts with no LIVE object (unknown, never approved, taken down) keep the plain
// 404, whose "/" would be the same page, and so does any other method or a failed read.
describe("the 404 page on a site host", () => {
  const PLAIN = "<p>There is no page at this address. Please check the address and try again.</p>\n</main>";
  const LINK = '<p>There is no page at this address. Please check the address and try again.</p>\n<p><a href="/">Go to Reliable Rooter Plumbing\'s page</a></p>\n</main>';

  async function notFoundPage(url: string, init: Init = {}): Promise<string> {
    const response = await get(url, init);
    expect(response.status, url).toBe(404);
    expect(response.headers.get("x-robots-tag"), url).toBe("noindex");
    expect(response.headers.get("cache-control"), url).toBe("no-store");
    return response.text();
  }

  it("links a wrong path on a live site to the site's page, by the business name", async () => {
    const site = await seedSite(tools, { metadata: BUSINESS_METADATA });
    for (const path of ["/old-page", "/index.html", "/_f/not-an-id/sent", "/a/b?c=d"]) expect(await notFoundPage(at(site.slug, path))).toContain(LINK);
    expect((await get(at(site.slug))).status).toBe(200); // where the link goes
  });

  it("keeps the plain 404 on a host with no approved page, for a page stored before the name was, and on an unknown host", async () => {
    const pending = await seedSite(tools, { live: false, metadata: BUSINESS_METADATA });
    expect(await notFoundPage(at(pending.slug, "/old-page"))).toContain(PLAIN);
    const legacy = await seedSite(tools, { metadata: PHONE_METADATA });
    expect(await notFoundPage(at(legacy.slug, "/old-page"))).toContain(PLAIN);
    expect(await notFoundPage(at("no-such-shop", "/old-page"))).toContain(PLAIN);
  });

  it("keeps the plain 404 for methods other than GET and HEAD", async () => {
    const site = await seedSite(tools, { metadata: BUSINESS_METADATA });
    for (const method of ["POST", "PUT", "DELETE"]) expect(await notFoundPage(at(site.slug, "/old-page"), { method, body: "x" })).toContain(PLAIN);
    const head = await get(at(site.slug, "/old-page"), { method: "HEAD" });
    expect(head.status).toBe(404);
  });

  // Review I-1: live slugs are public, so the link must not cost a D1 query (Decision 24; worker.test counts
  // a burst). A takedown deletes the LIVE object; until a failed delete is retried, the link stays, and its
  // "/" answers the plain 404.
  it("takes the name from the LIVE object alone: no D1 needed, even while a failed takedown delete leaves the object", async () => {
    const site = await seedSite(tools, { metadata: BUSINESS_METADATA });
    const down = await seedSite(tools, { takenDown: true, metadata: BUSINESS_METADATA });
    await tools.DB.prepare("ALTER TABLE sites RENAME TO sites_offline").run();
    try {
      for (const path of ["/x1", "/x1", "/x2", "/robots.txt", "/wp-login.php"]) expect(await notFoundPage(at(site.slug, path))).toContain(LINK);
    } finally {
      await tools.DB.prepare("ALTER TABLE sites_offline RENAME TO sites").run();
    }
    expect(await notFoundPage(at(down.slug, "/old-page"))).toContain(LINK);
    expect(await notFoundPage(at(down.slug))).toContain(PLAIN);
  });

  it("escapes the name", async () => {
    const site = await seedSite(tools, { metadata: { ...BUSINESS_METADATA, businessName: '<img src=x onerror="alert(1)"> & Co' } });
    const body = await notFoundPage(at(site.slug, "/old-page"));
    expect(body).toContain('<a href="/">Go to &lt;img src=x onerror="alert(1)"&gt; &amp; Co\'s page</a>');
    expect(body).not.toContain("<img");
  });
});
