import { isId, livePageKey, livePointerKey, pageCacheUrl } from "@asksite/core";
import type { PageId } from "@asksite/site-schema";
import { businessOf } from "./business.ts";
import type { Env } from "./env.ts";
import { browserCopyHeaders, edgeCopyHeaders, livePageHeaders } from "./headers.ts";
import { notFound, unavailable } from "./pages.ts";

const LIVE_SITE = "SELECT indexable, live_version_id FROM sites WHERE slug = ? AND live_version_id IS NOT NULL AND taken_down_at IS NULL";

/**
 * GET of any of a site's pages on a site host. The site's LIVE pointer is read first and names the live version
 * (U2: every page switches with one pointer write, and a deleted pointer stops every page at once). A slug with
 * no pointer never reaches D1 (one shared, single-threaded database; Decision 24). The edge-cache key carries
 * the version id, so a cached page can only ever be served for the version the pointer names. On a miss the
 * page is read at the immutable key under that version, D1 decides whether to serve, and the version must be
 * the one D1 says is live. Browsers are told to revalidate on every view (no-cache); the edge keeps a copy for
 * 60 s, so a takedown or the search-engine switch spreads within about a minute (an approval or a takedown goes
 * through the pointer, which is read on every request).
 */
export async function servePage(env: Env, ctx: ExecutionContext, slug: string, page: PageId): Promise<Response> {
  const root = env.ROOT_DOMAIN;
  let pointer: R2Object | null;
  try {
    pointer = await env.LIVE.head(livePointerKey(slug));
  } catch {
    return unavailable(root);
  }
  // Never approved, unknown, or taken down (the takedown deletes the pointer first). Not cached.
  if (pointer === null) return notFound(root);
  const versionId = pointer.customMetadata?.["versionId"];
  // A damaged pointer never chooses a key.
  if (versionId === undefined || !isId(versionId)) return unavailable(root);

  const cacheKey = new Request(pageCacheUrl(root, slug, versionId, page));
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached !== undefined) return new Response(cached.body, { status: cached.status, headers: browserCopyHeaders(cached.headers) });

  let body: ArrayBuffer;
  let site: { indexable: number; live_version_id: string } | null;
  try {
    const object = await env.LIVE.get(livePageKey(slug, versionId, page));
    // Home missing behind a pointer is a broken state. Another page missing is a page the site does not have: the
    // 404 links Home, named from the pointer (no extra read, no D1). Not cached.
    if (object === null) return page === "home" ? unavailable(root) : notFound(root, businessOf(pointer.customMetadata).name);
    body = await object.arrayBuffer();
    site = await env.DB.prepare(LIVE_SITE).bind(slug).first<{ indexable: number; live_version_id: string }>();
  } catch {
    return unavailable(root);
  }
  // Not live, or taken down (D1 alone decides; LIVE may still hold the pages). Not cached.
  if (site === null) return notFound(root);
  // The pointer names another version than D1's live one (an approval or restore half-way, or a late write of an
  // older version): never serve it. Not cached; the next request sees the fix.
  if (versionId !== site.live_version_id) return unavailable(root);

  const headers = livePageHeaders(root, site.indexable === 1);
  ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers: edgeCopyHeaders(headers) })));
  return new Response(body, { headers });
}
