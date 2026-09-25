import { ApiError, readJson, slugProblem } from "@asksite/app-common";
import { SetSlugBody } from "@asksite/core";
import { Hono } from "hono";
import { ownedSite } from "../db.ts";
import { requireOwner } from "../session.ts";
import type { AppEnv } from "../types.ts";

/** The web address: live availability check and setting it (§2.5, §3.1 step 3.7, §4.4). */
export function slugRoutes(): Hono<AppEnv> {
  const slugs = new Hono<AppEnv>();

  slugs.get("/slugs/:slug/availability", requireOwner, async (c) => {
    const slug = c.req.param("slug");
    const problem = slugProblem(slug);
    if (problem !== null) return c.json({ available: false, reason: problem });
    const taken = await c.env.DB.prepare("SELECT 1 AS taken FROM sites WHERE slug = ?").bind(slug).first();
    return c.json({ available: taken === null, reason: taken === null ? null : "taken" });
  });

  slugs.put("/sites/:siteId/slug", requireOwner, async (c) => {
    const owner = c.get("owner");
    const siteId = c.req.param("siteId");
    const body = await readJson(c, SetSlugBody);
    const problem = slugProblem(body.slug);
    if (problem !== null) {
      throw new ApiError("slug_invalid", "That web address cannot be used", {
        issues: [{ path: ["slug"], code: problem, message: "That web address cannot be used" }],
      });
    }
    const db = c.env.DB;
    let changes: number;
    try {
      // The address locks once a version is pending or live: the form action and live key contain it.
      const result = await db
        .prepare(
          `UPDATE sites SET slug = ?, rev = rev + 1, updated_at = ?
           WHERE id = ? AND owner_id = ? AND rev = ? AND taken_down_at IS NULL
             AND live_version_id IS NULL AND pending_version_id IS NULL`,
        )
        .bind(body.slug, Date.now(), siteId, owner.id, body.rev)
        .run();
      changes = result.meta.changes;
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed: sites.slug")) {
        throw new ApiError("slug_taken", "Someone else already has that web address");
      }
      throw err;
    }
    const site = await ownedSite(db, siteId, owner.id);
    if (changes !== 1) {
      if (site.taken_down_at !== null) throw new ApiError("site_taken_down", "This website has been taken offline. Contact us to restore it.");
      if (site.live_version_id !== null || site.pending_version_id !== null) {
        throw new ApiError("slug_locked", "The web address cannot change after the site has been sent for review");
      }
      throw new ApiError("conflict", "This site changed in another tab or window", { currentRev: site.rev });
    }
    return c.json({ rev: site.rev, slug: site.slug });
  });

  return slugs;
}
