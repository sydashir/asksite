import { canonicalJson, pagesDigest, sha256Hex, versionKey, versionPageKey, type VersionPages } from "@asksite/core";
import type { RenderedSite } from "@asksite/renderer";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPendingVersion } from "../src/index.ts";
import { publishFailure as failure } from "./support/errors.ts";
import { auditActions, doc, EDITS, flakyBucket, publishingHarness, seedSite, siteRow, versionRow, type PublishEnv } from "./support/harness.ts";

// The renderer gives one page for now (A16-2). Here it is replaced, so create's handling of a site with several
// pages is tested: what is stored in WORK and D1, and what a refused request leaves behind. vi.mock is hoisted.
const rendered: { site: RenderedSite | null } = vi.hoisted(() => ({ site: null }));
vi.mock("@asksite/renderer", async (importOriginal) => {
  const original = await importOriginal<typeof import("@asksite/renderer")>();
  return { ...original, render: (...args: Parameters<typeof original.render>) => rendered.site ?? original.render(...args) };
});

const harness = publishingHarness("publishing-pages-test");
let env: PublishEnv;
beforeAll(async () => {
  env = await harness.start();
}, 120_000);
afterAll(async () => {
  await harness.server.close();
});

const SITE = (pages: Array<{ page: "home" | "services" | "about" | "gallery" | "contact"; path: "/" | "/services" | "/about" | "/gallery" | "/contact" }>): RenderedSite => ({
  design: "impact",
  stylesheetSha256: "a".repeat(64),
  pages: pages.map((p) => ({ ...p, html: `<!DOCTYPE html><p>${p.page}</p>` })),
});
const ALL = SITE([
  { page: "home", path: "/" },
  { page: "services", path: "/services" },
  { page: "about", path: "/about" },
  { page: "contact", path: "/contact" },
]);

describe("createPendingVersion with several pages (A16)", () => {
  it("stores every page in WORK with its own metadata, and the pages, their digest and Home's key in the row", async () => {
    rendered.site = ALL;
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const summary = await createPendingVersion(env, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 1 });
    const pages: VersionPages = await Promise.all(ALL.pages.map(async (p) => ({ page: p.page, sha256: await sha256Hex(p.html) })));
    for (const p of ALL.pages) {
      const object = await env.WORK.get(versionPageKey(siteId, summary.id, p.page));
      expect(await object?.text()).toBe(p.html);
      expect(object?.httpMetadata?.contentType).toBe("text/html; charset=utf-8");
      expect(object?.customMetadata).toEqual({ siteId, versionId: summary.id, page: p.page, sha256: await sha256Hex(p.html) });
    }
    expect(await versionRow(env.DB, summary.id)).toMatchObject({
      pages_json: canonicalJson(pages), html_key: versionKey(siteId, summary.id), html_sha256: await pagesDigest(pages), stylesheet_sha256: "a".repeat(64),
    });
  });

  it("deletes every page's WORK key in one call when the batch refuses the request", async () => {
    rendered.site = ALL;
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const calls: Array<{ call: string; arg: unknown }> = [];
    const racing = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        await env.DB.prepare("UPDATE sites SET taken_down_at = 2 WHERE id = ?").bind(siteId).run(); // after the early checks
        return env.DB.batch(statements);
      },
    } as unknown as D1Database;
    const error = await failure(createPendingVersion({ ...env, DB: racing, WORK: flakyBucket(env.WORK, () => false, calls) }, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 1 }));
    expect(error.code).toBe("site_taken_down");
    const deletes = calls.filter((c) => c.call === "delete").map((c) => c.arg as string[]);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toHaveLength(ALL.pages.length);
    expect(deletes[0]?.every((key) => key.startsWith(`versions/${siteId}/`))).toBe(true);
    expect((await env.WORK.list({ prefix: `versions/${siteId}/` })).objects).toEqual([]);
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBeNull();
    expect(await auditActions(env.DB, siteId)).toEqual([]);
  });

  it.each([
    ["Home not first", SITE([{ page: "services", path: "/services" }, { page: "home", path: "/" }])],
    ["no pages", SITE([])],
    ["a page twice", SITE([{ page: "home", path: "/" }, { page: "home", path: "/" }])],
  ])("answers render_failed when the renderer returns %s, and stores nothing", async (_name, site) => {
    rendered.site = site;
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const error = await failure(createPendingVersion(env, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 1 }));
    expect(error.code).toBe("render_failed");
    expect(error.detail).toEqual([{ path: [], code: "render_failed", message: "The renderer returned an invalid list of pages" }]);
    expect((await env.WORK.list({ prefix: `versions/${siteId}/` })).objects).toEqual([]);
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBeNull();
  });
});
