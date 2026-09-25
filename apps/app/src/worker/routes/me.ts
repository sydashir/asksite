import type { SiteRow, SiteSummary } from "@asksite/core";
import { Hono } from "hono";
import { parseStored } from "../db.ts";
import { requireOwner } from "../session.ts";
import type { AppEnv } from "../types.ts";

function businessName(factsJson: string): string | null {
  const facts = parseStored(factsJson);
  const name = typeof facts === "object" && facts !== null ? (facts as { businessName?: unknown }).businessName : undefined;
  return typeof name === "string" && name.trim() !== "" ? name : null;
}

function summary(site: SiteRow): SiteSummary {
  return {
    id: site.id,
    slug: site.slug,
    businessName: businessName(site.facts_json),
    live: site.live_version_id !== null && site.taken_down_at === null,
    inReview: site.pending_version_id !== null,
    takenDown: site.taken_down_at !== null,
  };
}

/** GET /api/me: the signed-in owner and their sites (§4.4). */
export function meRoutes(): Hono<AppEnv> {
  const me = new Hono<AppEnv>();
  me.get("/me", requireOwner, async (c) => {
    const owner = c.get("owner");
    const { results } = await c.env.DB.prepare("SELECT * FROM sites WHERE owner_id = ? ORDER BY created_at").bind(owner.id).all<SiteRow>();
    return c.json({ owner, sites: results.map(summary) });
  });
  return me;
}
