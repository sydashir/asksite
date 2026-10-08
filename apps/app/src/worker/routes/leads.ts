import { ApiError } from "@asksite/app-common";
import type { LeadRow, LeadView } from "@asksite/core";
import { Hono } from "hono";
import { z } from "zod";
import { ownedSite } from "../db.ts";
import { requireOwner } from "../session.ts";
import type { AppEnv } from "../types.ts";

const LeadsQuery = z.strictObject({
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * GET /api/sites/:siteId/leads: newest first, not spam, paged by created_at (§4.4). `before` is
 * exclusive, so a page never ends inside one millisecond: it takes every lead of its last
 * millisecond, and may then hold a few more than `limit` (decision 35).
 */
export function leadRoutes(): Hono<AppEnv> {
  const leads = new Hono<AppEnv>();

  leads.get("/sites/:siteId/leads", requireOwner, async (c) => {
    const db = c.env.DB;
    const site = await ownedSite(db, c.req.param("siteId"), c.get("owner").id);
    const query = LeadsQuery.safeParse(c.req.query());
    if (!query.success) throw new ApiError("bad_request", "Invalid page request");
    const { before, limit } = query.data;
    const { results } = await db
      .prepare(`SELECT * FROM leads WHERE site_id = ? AND spam = 0 AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(site.id, before ?? Number.MAX_SAFE_INTEGER, limit + 1)
      .all<LeadRow>();
    let page = results.slice(0, limit);
    let nextBefore: number | null = null;
    const edge = page.at(-1)?.created_at;
    if (edge !== undefined && results.length > limit) {
      nextBefore = edge;
      if (results[limit]?.created_at === edge) {
        const tied = await db
          .prepare("SELECT * FROM leads WHERE site_id = ? AND spam = 0 AND created_at = ? ORDER BY id DESC")
          .bind(site.id, edge)
          .all<LeadRow>();
        page = [...page.filter((lead) => lead.created_at !== edge), ...tied.results];
        const older = await db.prepare("SELECT 1 AS found FROM leads WHERE site_id = ? AND spam = 0 AND created_at < ? LIMIT 1").bind(site.id, edge).first();
        if (older === null) nextBefore = null;
      }
    }
    const view: LeadView[] = page.map((lead) => ({
      id: lead.id,
      createdAt: lead.created_at,
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      service: lead.service,
      message: lead.message,
      emailStatus: lead.email_status,
    }));
    return c.json({ leads: view, nextBefore });
  });

  return leads;
}
