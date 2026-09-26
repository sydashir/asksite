import { ApiError, rateLimit, readBytes } from "@asksite/app-common";
import { LIMITS, mediaKey, mediaUrl, newId, type UploadView } from "@asksite/core";
import { Hono } from "hono";
import { assertNotTakenDown, ownedSite } from "../db.ts";
import { imageInfo, sizeProblem, sniffImage, toStillWebp } from "../images.ts";
import { requireOwner } from "../session.ts";
import type { AppEnv } from "../types.ts";

// The multipart wrapper (boundaries and part headers) around one 10 MB file.
const MULTIPART_OVERHEAD_BYTES = 16 * 1024;
const UPLOAD_CAP_RETRY_SECONDS = 86_400;

function limitReached(): ApiError {
  return new ApiError("upload_limit_reached", "This site has reached its photo limit. Remove a photo to add another.", {
    retryAfter: UPLOAD_CAP_RETRY_SECONDS,
  });
}

/** The multipart body as FormData. A body that cannot be parsed makes formData() throw a TypeError: the client's mistake, not ours. */
async function readForm(url: string, contentType: string, body: Uint8Array): Promise<FormData> {
  try {
    return await new Request(url, { method: "POST", headers: { "Content-Type": contentType }, body }).formData();
  } catch (err) {
    if (err instanceof TypeError) throw new ApiError("bad_request", "The upload is not valid multipart form data");
    throw err;
  }
}

async function underCaps(db: D1Database, siteId: string): Promise<boolean> {
  const counts = await db
    .prepare("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE deleted_at IS NULL) AS kept FROM uploads WHERE site_id = ?")
    .bind(siteId)
    .first<{ total: number; kept: number }>();
  return counts !== null && counts.kept < LIMITS.uploadsPerSite && counts.total < LIMITS.uploadsPerSiteTotal;
}

/** POST and DELETE /api/sites/:siteId/uploads (§4.4, §8). */
export function uploadRoutes(): Hono<AppEnv> {
  const uploads = new Hono<AppEnv>();

  uploads.post("/sites/:siteId/uploads", requireOwner, async (c) => {
    const owner = c.get("owner");
    await rateLimit(c.env.UPLOAD_RL, owner.id);
    if (!/^multipart\/form-data\s*;/i.test(c.req.header("Content-Type") ?? "")) throw new ApiError("forbidden", "Expected a file upload");
    const db = c.env.DB;
    const site = await ownedSite(db, c.req.param("siteId"), owner.id);
    // A taken-down site is frozen: no image work and no storage for it (decision 39).
    assertNotTakenDown(site);
    // Pre-check so a refused upload costs no image transformation.
    if (!(await underCaps(db, site.id))) throw limitReached();

    const body = await readBytes(c.req.raw, LIMITS.uploadMaxBytes + MULTIPART_OVERHEAD_BYTES);
    const form = await readForm(c.req.url, c.req.header("Content-Type") ?? "", body);
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError("bad_request", "Choose a photo to upload");
    if (file.size > LIMITS.uploadMaxBytes) throw new ApiError("payload_too_large", "That photo is over 10 MB. Please choose a smaller one.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (sniffImage(bytes) === null) throw new ApiError("unsupported_media_type", "Please choose a JPG, PNG or WebP photo");

    const info = await imageInfo(c.env.IMAGES, bytes);
    if (info === null) throw new ApiError("image_rejected", "We could not read that photo. Please choose a JPG or PNG photo.");
    const problem = sizeProblem(info.width, info.height);
    if (problem === "too_small") throw new ApiError("image_rejected", "That photo is too small. Please choose one at least 200 pixels wide and tall.");
    if (problem === "too_many_pixels") throw new ApiError("image_rejected", "That photo is too large. Please choose a smaller one.");

    const still = await toStillWebp(c.env.IMAGES, bytes);
    const id = newId();
    const now = Date.now();
    // The exact caps: the row is created only while both counts are under their limits.
    const inserted = await db
      .prepare(
        `INSERT INTO uploads (id, site_id, width, height, bytes, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE (SELECT COUNT(*) FROM uploads WHERE site_id = ?2 AND deleted_at IS NULL) < ?7
           AND (SELECT COUNT(*) FROM uploads WHERE site_id = ?2) < ?8`,
      )
      .bind(id, site.id, still.width, still.height, still.webp.byteLength, now, LIMITS.uploadsPerSite, LIMITS.uploadsPerSiteTotal)
      .run();
    if (inserted.meta.changes !== 1) throw limitReached();
    try {
      await c.env.MEDIA.put(mediaKey(site.id, id), still.webp, {
        httpMetadata: { contentType: "image/webp" },
        customMetadata: { siteId: site.id, uploadId: id },
      });
    } catch (err) {
      await db.prepare("DELETE FROM uploads WHERE id = ?").bind(id).run();
      throw err;
    }
    const view: UploadView = {
      id,
      url: mediaUrl(c.env.ROOT_DOMAIN, site.id, id),
      width: still.width,
      height: still.height,
      bytes: still.webp.byteLength,
      createdAt: now,
    };
    return c.json(view, 201);
  });

  uploads.delete("/sites/:siteId/uploads/:uploadId", requireOwner, async (c) => {
    const site = await ownedSite(c.env.DB, c.req.param("siteId"), c.get("owner").id);
    // Soft delete: a pending or live version may still show the photo (§8 step 4).
    const result = await c.env.DB.prepare("UPDATE uploads SET deleted_at = ? WHERE id = ? AND site_id = ? AND deleted_at IS NULL")
      .bind(Date.now(), c.req.param("uploadId"), site.id)
      .run();
    if (result.meta.changes !== 1) throw new ApiError("not_found", "Not found");
    return c.body(null, 204);
  });

  return uploads;
}
