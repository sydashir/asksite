import { liveKey, mediaKey, newId } from "@asksite/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { at, BUSINESS_METADATA, PHONE_METADATA, putLive, ROOT, seedSite, seedUpload, sitesHarness, type ToolsEnv } from "./support/harness.ts";

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
const CSP = `default-src 'none'; style-src 'unsafe-inline'; img-src https://media.${ROOT}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

describe("live pages", () => {
  it("serves the approved bytes with the page headers and no noindex", async () => {
    const site = await seedSite(tools);
    const response = await get(at(site.slug));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(site.html);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60",
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

  it("D1 decides: a site that is not live gets 404 even when a LIVE object exists", async () => {
    const draft = await seedSite(tools, { live: false, withObject: true });
    expect((await get(at(draft.slug))).status).toBe(404);
    const takenDown = await seedSite(tools, { takenDown: true });
    const response = await get(at(takenDown.slug));
    expect(response.status).toBe(404);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("returns 404 without caching while the LIVE object is still missing", async () => {
    const site = await seedSite(tools, { withObject: false });
    expect((await get(at(site.slug))).status).toBe(404);
    await putLive(tools, site);
    expect((await get(at(site.slug))).status).toBe(200);
  });

  it("never asks D1 about a slug with no approved page: with D1's sites table gone it is still 404, not 503", async () => {
    await tools.DB.prepare("ALTER TABLE sites RENAME TO sites_offline").run();
    try {
      expect((await get(at("no-such-shop"))).status).toBe(404);
    } finally {
      await tools.DB.prepare("ALTER TABLE sites_offline RENAME TO sites").run();
    }
  });

  it("answers 503, uncached, while LIVE holds another version than the one D1 says is live", async () => {
    const site = await seedSite(tools);
    await putLive(tools, { ...site, versionId: newId(), html: "<!DOCTYPE html><p>an older version</p>" });
    const stale = await get(at(site.slug));
    expect(stale.status).toBe(503);
    expect(stale.headers.get("retry-after")).toBe("60");
    expect(stale.headers.get("x-robots-tag")).toBe("noindex");
    await putLive(tools, site);
    expect(await (await get(at(site.slug))).text()).toBe(site.html);
  });

  it("keeps a served page in this data centre's cache for its 60 s TTL", async () => {
    const site = await seedSite(tools);
    expect((await get(at(site.slug))).status).toBe(200);
    await tools.DB.prepare("UPDATE sites SET taken_down_at = 99 WHERE id = ?").bind(site.siteId).run();
    await tools.LIVE.delete(liveKey(site.slug));
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
      "cache-control": "public, max-age=86400, s-maxage=300",
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

  it("never asks D1 about a photo that is not stored: with D1's uploads table gone it is still 404, not 503", async () => {
    await tools.DB.prepare("ALTER TABLE uploads RENAME TO uploads_offline").run();
    try {
      expect((await get(media(newId(), newId()))).status).toBe(404);
    } finally {
      await tools.DB.prepare("ALTER TABLE uploads_offline RENAME TO uploads").run();
    }
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
    for (const path of ["/index.html", "/wp-admin", `/${liveKey(site.slug)}`]) {
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
// object's metadata. Hosts with no live page (unknown, never approved, taken down) keep the plain 404,
// whose "/" would be the same page, and so does any other method or a failed read.
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
    for (const path of ["/contact", "/index.html", "/_f/not-an-id/sent", "/a/b?c=d"]) expect(await notFoundPage(at(site.slug, path))).toContain(LINK);
    expect((await get(at(site.slug))).status).toBe(200); // where the link goes
  });

  it.each([
    ["a host with no approved page", { live: false, withObject: false }],
    ["a site D1 does not call live, even with a LIVE object", { live: false, withObject: true }],
    ["a taken-down site whose LIVE object is still there", { takenDown: true }],
  ])("keeps the plain 404 on %s", async (_, options) => {
    const site = await seedSite(tools, { ...options, metadata: BUSINESS_METADATA });
    expect(await notFoundPage(at(site.slug, "/contact"))).toContain(PLAIN);
  });

  it("keeps the plain 404 for a page stored before the name was, and on an unknown host", async () => {
    const legacy = await seedSite(tools, { metadata: PHONE_METADATA });
    expect(await notFoundPage(at(legacy.slug, "/contact"))).toContain(PLAIN);
    expect(await notFoundPage(at("no-such-shop", "/contact"))).toContain(PLAIN);
  });

  it("keeps the plain 404 for methods other than GET and HEAD", async () => {
    const site = await seedSite(tools, { metadata: BUSINESS_METADATA });
    for (const method of ["POST", "PUT", "DELETE"]) expect(await notFoundPage(at(site.slug, "/contact"), { method, body: "x" })).toContain(PLAIN);
    const head = await get(at(site.slug, "/contact"), { method: "HEAD" });
    expect(head.status).toBe(404);
  });

  it("keeps the plain 404, not a 503, when D1 fails", async () => {
    const site = await seedSite(tools, { metadata: BUSINESS_METADATA });
    await tools.DB.prepare("ALTER TABLE sites RENAME TO sites_offline").run();
    try {
      expect(await notFoundPage(at(site.slug, "/contact"))).toContain(PLAIN);
    } finally {
      await tools.DB.prepare("ALTER TABLE sites_offline RENAME TO sites").run();
    }
  });

  it("escapes the name", async () => {
    const site = await seedSite(tools, { metadata: { ...BUSINESS_METADATA, businessName: '<img src=x onerror="alert(1)"> & Co' } });
    const body = await notFoundPage(at(site.slug, "/contact"));
    expect(body).toContain('<a href="/">Go to &lt;img src=x onerror="alert(1)"&gt; &amp; Co\'s page</a>');
    expect(body).not.toContain("<img");
  });
});
