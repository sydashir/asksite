import { livePageKey, pageUrl } from "@asksite/core";
import type { PageId } from "@asksite/site-schema";
import { liveSiteName } from "./business.ts";
import type { Env } from "./env.ts";
import { livePageHeaders } from "./headers.ts";
import { notFound, unavailable } from "./pages.ts";

const LIVE_SITE = "SELECT indexable, live_version_id FROM sites WHERE slug = ? AND live_version_id IS NOT NULL AND taken_down_at IS NULL";

/**
 * GET of any of a site's pages on a site host (one LIVE object per page). R2 is read first, so a slug with no approved page never reaches D1 (one
 * shared, single-threaded database; Decision 24). D1 then decides whether to serve, and the bytes
 * must be the version D1 says is live. Served pages are kept in this data centre's cache for 60 s,
 * so approvals, takedowns and the search-engine switch spread within about a minute (plus up to
 * 60 s in a visitor's browser).
 */
export async function servePage(env: Env, ctx: ExecutionContext, slug: string, page: PageId): Promise<Response> {
  const root = env.ROOT_DOMAIN;
  const cacheKey = new Request(pageUrl(root, slug, page));
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached !== undefined) return cached;

  let body: ArrayBuffer;
  let versionId: string | undefined;
  let site: { indexable: number; live_version_id: string } | null;
  try {
    const object = await env.LIVE.get(livePageKey(slug, page));
    // Never approved, unknown, a page the site does not have, or the seconds between an approval's D1 write
    // and its R2 write. Not cached. A missing inner page links Home, as any wrong path does.
    if (object === null) return page === "home" ? notFound(root) : notFound(root, await liveSiteName(env.LIVE, slug));
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
