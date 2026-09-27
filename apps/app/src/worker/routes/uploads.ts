import { ApiError, noteLog, rateLimit, readBytes, runToEnd } from "@asksite/app-common";
import { LIMITS, mediaKey, mediaUrl, newId, type UploadView } from "@asksite/core";
import { Hono } from "hono";
import { assertNotTakenDown, ownedSite } from "../db.ts";
import { imageInfo, sizeProblem, sniffImage, toStillWebp } from "../images.ts";
import { multipartBoundary, multipartShapeProblem } from "../multipart.ts";
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

/** The file is a real JPEG, PNG or WebP by its first bytes, but the image service cannot decode it. */
function unreadablePhoto(): ApiError {
  return new ApiError("image_rejected", "We could not read that photo. Please choose a JPG or PNG photo.");
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

/** One uploads row to create: a stored photo (deletedAt null) or a counted transform failure (deleted at once). */
interface UploadRowValues {
  id: string;
  siteId: string;
  width: number;
  height: number;
  bytes: number;
  createdAt: number;
  deletedAt: number | null;
}

/** The exact caps: the row is created only while both counts are under their limits. False when it was not. */
async function insertUnderCaps(db: D1Database, row: UploadRowValues): Promise<boolean> {
  const inserted = await db
    .prepare(
      `INSERT INTO uploads (id, site_id, width, height, bytes, created_at, deleted_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
       WHERE (SELECT COUNT(*) FROM uploads WHERE site_id = ?2 AND deleted_at IS NULL) < ?8
         AND (SELECT COUNT(*) FROM uploads WHERE site_id = ?2) < ?9`,
    )
    .bind(row.id, row.siteId, row.width, row.height, row.bytes, row.createdAt, row.deletedAt, LIMITS.uploadsPerSite, LIMITS.uploadsPerSiteTotal)
    .run();
  return inserted.meta.changes === 1;
}

/**
 * Stores a re-encoded photo: its row under the exact caps, then its object in MEDIA; when the object cannot be
 * stored, the row is removed again. False when the caps refused the row, and then nothing is stored.
 */
async function storeUpload(env: Env, row: UploadRowValues, webp: Uint8Array): Promise<boolean> {
  if (!(await insertUnderCaps(env.DB, row))) return false;
  try {
    await env.MEDIA.put(mediaKey(row.siteId, row.id), webp, {
      httpMetadata: { contentType: "image/webp" },
      customMetadata: { siteId: row.siteId, uploadId: row.id },
    });
  } catch (err) {
    await env.DB.prepare("DELETE FROM uploads WHERE id = ?").bind(row.id).run();
    throw err;
  }
  return true;
}

/** POST and DELETE /api/sites/:siteId/uploads (§4.4, §8). */
export function uploadRoutes(): Hono<AppEnv> {
  const uploads = new Hono<AppEnv>();

  uploads.post("/sites/:siteId/uploads", requireOwner, async (c) => {
    const owner = c.get("owner");
    await rateLimit(c.env.UPLOAD_RL, owner.id);
    const contentType = c.req.header("Content-Type") ?? "";
    if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new ApiError("forbidden", "Expected a file upload");
    const db = c.env.DB;
    const site = await ownedSite(db, c.req.param("siteId"), owner.id);
    // A taken-down site is frozen: no image work and no storage for it (decision 39).
    assertNotTakenDown(site);
    // Pre-check so a refused upload costs no image transformation. A transform that gives no WebP to store (the
    // file made it fail, or the service answered another format) is counted as a deleted upload (P4-14, P4-15 b),
    // so the 150 total cap bounds those transforms too. The accepted known limit (P4-13, security review I2) is
    // only the concurrency window at a cap boundary: uploads racing there each pass this pre-check and each run
    // a transform, while the exact INSERT below creates rows only up to the caps; past the boundary the pre-check
    // refuses before any transform.
    if (!(await underCaps(db, site.id))) throw limitReached();

    const body = await readBytes(c.req.raw, LIMITS.uploadMaxBytes + MULTIPART_OVERHEAD_BYTES);
    // Before the parse, which walks every part and every header byte (P4-15 d): more parts than an upload has,
    // or a header that runs on for kilobytes, would only make it slow while the isolate's other requests wait.
    const boundary = multipartBoundary(contentType);
    const shape = boundary === null ? null : multipartShapeProblem(body, boundary);
    if (shape !== null) {
      noteLog(c, { event: "multipart_refused", reason: shape });
      throw new ApiError("bad_request", "The upload is not valid multipart form data");
    }
    const form = await readForm(c.req.url, contentType, body);
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError("bad_request", "Choose a photo to upload");
    if (file.size > LIMITS.uploadMaxBytes) throw new ApiError("payload_too_large", "That photo is over 10 MB. Please choose a smaller one.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (sniffImage(bytes) === null) throw new ApiError("unsupported_media_type", "Please choose a JPG, PNG or WebP photo");

    const info = await imageInfo(c.env.IMAGES, bytes);
    if (info === null) throw unreadablePhoto();
    const problem = sizeProblem(info.width, info.height);
    if (problem === "too_small") throw new ApiError("image_rejected", "That photo is too small. Please choose one at least 200 pixels wide and tall.");
    if (problem === "too_many_pixels") throw new ApiError("image_rejected", "That photo is too large. Please choose a smaller one.");

    const still = await toStillWebp(c.env.IMAGES, bytes);
    const now = Date.now();
    if (still === null) {
      // The transform ran and gave no WebP to store: the file made it fail, or it answered another format
      // (P4-15 b). It is counted like an upload deleted at once, so the 150 total cap bounds these too
      // (P4-14); the row has no object and is never shown.
      const counted = await insertUnderCaps(db, { id: newId(), siteId: site.id, width: 0, height: 0, bytes: 0, createdAt: now, deletedAt: now });
      throw counted ? unreadablePhoto() : limitReached();
    }
    const id = newId();
    const row: UploadRowValues = { id, siteId: site.id, width: still.width, height: still.height, bytes: still.webp.byteLength, createdAt: now, deletedAt: null };
    // From the row to its object, the work runs to its end even if the client goes away (P4-8's runToEnd), so
    // no row is left without its photo.
    if (!(await runToEnd(c.executionCtx, storeUpload(c.env, row, still.webp)))) throw limitReached();
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
