import { liveKey, siteUrl } from "@asksite/core";
import { businessOf } from "./business.ts";
import type { Env } from "./env.ts";
import { livePageHeaders } from "./headers.ts";
import { notFound, unavailable } from "./pages.ts";

const LIVE_SITE = "SELECT indexable, live_version_id FROM sites WHERE slug = ? AND live_version_id IS NOT NULL AND taken_down_at IS NULL";

/**
 * GET / on a site host. R2 is read first, so a slug with no approved page never reaches D1 (one
 * shared, single-threaded database; Decision 24). D1 then decides whether to serve, and the bytes
 * must be the version D1 says is live. Served pages are kept in this data centre's cache for 60 s,
 * so approvals, takedowns and the search-engine switch spread within about a minute (plus up to
 * 60 s in a visitor's browser).
 */
export async function servePage(env: Env, ctx: ExecutionContext, slug: string): Promise<Response> {
  const root = env.ROOT_DOMAIN;
  const cacheKey = new Request(siteUrl(root, slug));
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached !== undefined) return cached;

  let body: ArrayBuffer;
  let versionId: string | undefined;
  let site: { indexable: number; live_version_id: string } | null;
  try {
    const object = await env.LIVE.get(liveKey(slug));
    // Never approved, unknown, or the seconds between an approval's D1 write and its R2 write. Not cached.
    if (object === null) return notFound(root);
    body = await object.arrayBuffer();
    versionId = object.customMetadata?.["versionId"];
    site = await env.DB.prepare(LIVE_SITE).bind(slug).first<{ indexable: number; live_version_id: string }>();
  } catch {
    return unavailable(root);
  }
  // Not live, or taken down (D1 alone decides; LIVE may still hold the bytes). Not cached.
  if (site === null) return notFound(root);
  // LIVE holds another version than D1's live one (an approval or restore half-way, or a late write
  // of an older version): never serve stale bytes. Not cached; the next request sees the fix.
  if (versionId !== site.live_version_id) return unavailable(root);

  const response = new Response(body, { headers: livePageHeaders(root, site.indexable === 1) });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

/**
 * The business name for the 404 page on a site host (QA-2 RU(3)), so a wrong path links to the site's page;
 * null keeps the plain 404. As for the page, R2 is read first: a host with no LIVE object (unknown or
 * never approved), or one whose object holds no name (stored before the name was), never reaches D1
 * (Decision 24). D1 then decides, so a taken-down site's host keeps the plain 404 even if LIVE still holds
 * its bytes. A failed read also keeps the plain 404, which is right without the link.
 */
export async function liveSiteName(env: Pick<Env, "DB" | "LIVE">, slug: string): Promise<string | null> {
  try {
    const object = await env.LIVE.head(liveKey(slug));
    const name = object === null ? null : businessOf(object.customMetadata).name;
    if (name === null) return null;
    return (await env.DB.prepare(LIVE_SITE).bind(slug).first()) === null ? null : name;
  } catch {
    return null;
  }
}
