import { isId, livePageKey, livePointerKey, pageCacheUrl } from "@asksite/core";
import type { PageId } from "@asksite/site-schema";
import { businessOf } from "./business.ts";
import type { Env } from "./env.ts";
import { browserCopyHeaders, edgeCopyHeaders, livePageHeaders } from "./headers.ts";
import { notFound, unavailable } from "./pages.ts";

/** How long a version's named 404 for a page the site lacks stays in this data centre's cache. A version's pages never change. */
const MISSING_PAGE_404_TTL_S = 60;
const LIVE_SITE = "SELECT indexable, live_version_id FROM sites WHERE slug = ? AND live_version_id IS NOT NULL AND taken_down_at IS NULL";

/**
 * GET of any of a site's pages on a site host. The site's LIVE pointer is read first and names the live version
 * (U2: every page switches with one pointer write, and a deleted pointer stops every page at once). A slug with
 * no pointer never reaches D1 (one shared, single-threaded database; Decision 24). The edge-cache key carries
 * the version id, so a cached page can only ever be served for the version the pointer names. On a miss the
 * page is read at the immutable key under that version, D1 decides whether to serve, and the version must be
 * the one D1 says is live. Browsers are told to revalidate on every view (no-cache); the edge keeps a copy for
 * 60 s. A takedown stops every page at once (it deletes the pointer first, and the pointer is read on every request,
 * before the cache; only a pointer a failed takedown left behind lets a cached page live out its 60 s). A change that
 * lives in D1 alone, such as the search-engine switch, takes up to 60 s to reach a cached page. Photos are different:
 * they are cached by their own URL, so a down site's photos stop within 60 s (media.ts).
 * An approval switches the pointer and then deletes the replaced version's pages (A16-4c), so a view that read the old
 * pointer can find its page gone: it reads the pointer once more, and if that now names another valid version it
 * serves that version (its own cache key, the same D1 check).
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
  return serveVersion(env, ctx, slug, page, pointer, true);
}

async function serveVersion(env: Env, ctx: ExecutionContext, slug: string, page: PageId, pointer: R2Object, rereadPointer: boolean): Promise<Response> {
  const root = env.ROOT_DOMAIN;
  const versionId = pointer.customMetadata?.["versionId"];
  // A damaged pointer never chooses a key.
  if (versionId === undefined || !isId(versionId)) return unavailable(root);

  const cacheKey = new Request(pageCacheUrl(root, slug, versionId, page));
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  // A hit is rebuilt, never passed on (browserCopyHeaders). A cached 404 is the version's missing page, named from the pointer.
  if (cached !== undefined) {
    return cached.status === 404 ? notFound(root, businessOf(pointer.customMetadata).name) : new Response(cached.body, { status: cached.status, headers: browserCopyHeaders(root, cached.headers) });
  }

  let body: ArrayBuffer;
  let site: { indexable: number; live_version_id: string } | null;
  try {
    const object = await env.LIVE.get(livePageKey(slug, versionId, page));
    if (object === null && rereadPointer) {
      const latest = await env.LIVE.head(livePointerKey(slug));
      const latestId = latest?.customMetadata?.["versionId"];
      if (latest !== null && latestId !== undefined && latestId !== versionId && isId(latestId)) return await serveVersion(env, ctx, slug, page, latest, false);
    }
    // Home missing behind a pointer is a broken state, not cached. Another page missing is a page the site does not have:
    // the 404 links Home, named from the pointer (no D1), and is cached for this version, so the next view costs only
    // the pointer head (the page get, the dearer read, is skipped).
    if (object === null) {
      if (page === "home") return unavailable(root);
      ctx.waitUntil(cache.put(cacheKey, new Response(null, { status: 404, headers: { "Cache-Control": `public, s-maxage=${MISSING_PAGE_404_TTL_S}` } })));
      return notFound(root, businessOf(pointer.customMetadata).name);
    }
    body = await object.arrayBuffer();
    site = await env.DB.prepare(LIVE_SITE).bind(slug).first<{ indexable: number; live_version_id: string }>();
  } catch {
    return unavailable(root);
  }
  // Not live, or taken down (D1 alone decides; LIVE may still hold the pages). Not cached.
  if (site === null) return notFound(root);
  // The pointer names another version than D1's live one (an approval half-way, or a late write of an older version):
  // never serve it. Not cached; the next request sees the fix. A restore half-way is the 404 above: D1 keeps
  // taken_down_at until the restore's clear commits.
  if (versionId !== site.live_version_id) return unavailable(root);

  const headers = livePageHeaders(root, site.indexable === 1);
  ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers: edgeCopyHeaders(headers) })));
  return new Response(body, { headers });
}
