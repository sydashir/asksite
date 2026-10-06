import { isId, mediaKey, mediaUrl } from "@asksite/core";
import type { Env } from "./env.ts";
import { mediaHeaders } from "./headers.ts";
import { notFound, unavailable } from "./pages.ts";

const MEDIA_PATH = /^\/([^/]+)\/([^/]+)\.webp$/;
/** How long a down site's photo answers 404 from this data centre's cache; a restore shows its photos again within this time. */
const DOWN_PHOTO_404_TTL_S = 60;
const SERVABLE = "SELECT 1 AS ok FROM uploads u JOIN sites s ON s.id = u.site_id WHERE u.id = ? AND u.site_id = ? AND s.taken_down_at IS NULL";

/**
 * GET /<siteId>/<uploadId>.webp on media.<root>. R2 first, so ids with no stored photo never reach D1 (Decision 24);
 * then served while the upload row exists for that site and the site is not taken down. A stored photo D1 does not
 * serve (a down site's) answers 404, kept in this data centre's cache for DOWN_PHOTO_404_TTL_S: repeats cost no R2
 * or D1 read, and a restore shows the photos again within that time.
 * Soft-deleted uploads are still served (a live or pending version may show them). URLs are two random
 * UUIDs, so unapproved photos are unguessable, not secret.
 */
export async function serveMedia(env: Env, ctx: ExecutionContext, pathname: string): Promise<Response> {
  const root = env.ROOT_DOMAIN;
  const match = MEDIA_PATH.exec(pathname);
  const siteId = match?.[1] ?? "";
  const uploadId = match?.[2] ?? "";
  if (!isId(siteId) || !isId(uploadId)) return notFound(root);

  const cacheKey = new Request(mediaUrl(root, siteId, uploadId));
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  // A hit is rebuilt, never passed on: the cache's own headers (Age, cf-cache-status) are not ours to send.
  if (cached !== undefined) return cached.status === 404 ? notFound(root) : new Response(cached.body, { headers: mediaHeaders() });

  let body: ArrayBuffer;
  try {
    const object = await env.MEDIA.get(mediaKey(siteId, uploadId));
    if (object === null) return notFound(root);
    body = await object.arrayBuffer();
    // A stored photo that D1 does not serve (a down site's, or one with no row): its 404 is kept, so repeats cost nothing.
    if ((await env.DB.prepare(SERVABLE).bind(uploadId, siteId).first()) === null) {
      ctx.waitUntil(cache.put(cacheKey, new Response(null, { status: 404, headers: { "Cache-Control": `public, s-maxage=${DOWN_PHOTO_404_TTL_S}` } })));
      return notFound(root);
    }
  } catch {
    return unavailable(root);
  }

  const response = new Response(body, { headers: mediaHeaders() });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
