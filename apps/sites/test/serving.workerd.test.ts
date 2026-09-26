import { liveKey, mediaKey, newId } from "@asksite/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { at, putLive, ROOT, seedSite, seedUpload, sitesHarness, type ToolsEnv } from "./support/harness.ts";

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
