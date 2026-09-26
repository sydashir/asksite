import { isId, mediaKey, mediaUrl } from "@asksite/core";
import type { Env } from "./env.ts";
import { mediaHeaders } from "./headers.ts";
import { notFound, unavailable } from "./pages.ts";

const MEDIA_PATH = /^\/([^/]+)\/([^/]+)\.webp$/;
const SERVABLE = "SELECT 1 AS ok FROM uploads u JOIN sites s ON s.id = u.site_id WHERE u.id = ? AND u.site_id = ? AND s.taken_down_at IS NULL";

/**
 * GET /<siteId>/<uploadId>.webp on media.<root>. R2 first, so ids with no stored photo never reach D1
 * (Decision 24); then served while the upload row exists for that site and the site is not taken down.
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
  if (cached !== undefined) return cached;

  let body: ArrayBuffer;
  let servable: unknown;
  try {
    const object = await env.MEDIA.get(mediaKey(siteId, uploadId));
    if (object === null) return notFound(root);
    body = await object.arrayBuffer();
    servable = await env.DB.prepare(SERVABLE).bind(uploadId, siteId).first();
  } catch {
    return unavailable(root);
  }
  if (servable === null) return notFound(root);

  const response = new Response(body, { headers: mediaHeaders() });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
