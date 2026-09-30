import { ApiError, logLine, noteLog, rateLimit, readBytes, runToEnd } from "@asksite/app-common";
import { LIMITS, mediaKey, mediaUrl, newId, type UploadView } from "@asksite/core";
import { type Context, Hono } from "hono";
import { assertNotTakenDown, ownedSite, siteTakenDown } from "../db.ts";
import { imageInfo, sizeProblem, sniffImage, toStillWebp } from "../images.ts";
import { multipartBoundary, multipartShapeProblem } from "../multipart.ts";
import { requireOwner } from "../session.ts";
import type { AppEnv } from "../types.ts";
import { ageOutSiteReservations, finishPhoto, isTakenDown, markFailed, release, reserve } from "../upload-reservations.ts";

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

/**
 * What the owner reads when an upload is refused as multipart, whichever rule refused it: one plain sentence
 * (P4-17 Condition 3, for every such refusal: P4-15 follow-up 2). The reason, the guard's or readForm's
 * form_unreadable (P4-15 parity), goes on the request's log line only, never into the answer.
 */
function uploadDidNotWork(): ApiError {
  return new ApiError("bad_request", "That upload didn't work. Please try again.");
}

/**
 * The multipart body as FormData. A body that cannot be parsed makes formData() throw a TypeError: the client's
 * mistake, not ours, refused like the guard's shapes, with its reason (form_unreadable) on the log line only.
 */
async function readForm(c: Context<AppEnv>, contentType: string, body: Uint8Array): Promise<FormData> {
  try {
    return await new Request(c.req.url, { method: "POST", headers: { "Content-Type": contentType }, body }).formData();
  } catch (err) {
    if (err instanceof TypeError) {
      noteLog(c, { event: "multipart_refused", reason: "form_unreadable" });
      throw uploadDidNotWork();
    }
    throw err;
  }
}

/**
 * The pre-check: whether both caps have room. Its batch (one transaction) first ages out the site's stale
 * reservations (P4-21), so one a request that died left behind holds a slot for at most 10 minutes; a live
 * reservation counts as kept, as it does in the INSERT that reserves.
 */
async function underCaps(db: D1Database, siteId: string, now: number): Promise<boolean> {
  const [, read] = await db.batch([
    ageOutSiteReservations(db, siteId, now),
    db.prepare("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE deleted_at IS NULL) AS kept FROM uploads WHERE site_id = ?").bind(siteId),
  ]);
  const counts = read?.results[0] as { total: number; kept: number } | undefined;
  return counts !== undefined && counts.kept < LIMITS.uploadsPerSite && counts.total < LIMITS.uploadsPerSiteTotal;
}

/** A stored photo's row, as the answer shows it. */
interface StoredPhoto {
  id: string;
  width: number;
  height: number;
  bytes: number;
  createdAt: number;
}

/** Which upload a clean-up or a lost reservation is about: record ids only, for its log line. */
interface UploadIds {
  uploadId: string;
  siteId: string;
}

/** The clean-up write a failed clean-up names: releasing the reservation, marking it failed, or deleting its object. */
type CleanUpStep = "release" | "mark_failed" | "media_delete";

/**
 * Runs a clean-up write after a failure without letting its own failure replace that one. A reservation it could not
 * change stays reserved, counted by both caps, until it is aged out into a counted failure: the fail-safe direction.
 * An object it could not delete stays in MEDIA. Either way it writes its own line (the error's class name, never its
 * message), as inBackground does: this work runs inside runToEnd and can outlive the request's one line.
 */
async function cleanUp(step: CleanUpStep, ids: UploadIds, write: Promise<unknown>): Promise<void> {
  try {
    await write;
  } catch (err) {
    logLine({ event: "upload_cleanup_failed", uploadId: ids.uploadId, siteId: ids.siteId, step, error: err instanceof Error ? err.name : "unknown" });
  }
}

/**
 * From the reservation to the row's final state (P4-21), which the route runs as one runToEnd (P4-15 follow-up 1).
 * The INSERT that reserves the upload's row under both caps comes first, so only a request that got a reservation runs
 * the billed transform (toStillWebp: its .output(), the read of its image and the free .info() of the result). Then
 * the photo's object is stored and its row finished; or, when the transform gave no WebP to store, the reservation is
 * marked as a counted failure; or, after a failure that is ours, it is released. Gives the stored photo; throws
 * site_taken_down when the site was taken down and upload_limit_reached when the caps refuse the reservation (no
 * billed call ran in either case), and image_rejected once a failure is counted.
 */
async function reserveTransformAndStore(env: Env, siteId: string, bytes: Uint8Array): Promise<StoredPhoto> {
  const id = newId();
  const ids: UploadIds = { uploadId: id, siteId };
  const reservedAt = Date.now();
  const reservation = await reserve(env.DB, id, siteId, reservedAt);
  // Decision 39: the route checked the site before reading the body, whose pace the owner sets; it may be down now.
  if (reservation === "taken_down") throw siteTakenDown();
  if (reservation === "full") throw limitReached();
  let still: Awaited<ReturnType<typeof toStillWebp>>;
  try {
    still = await toStillWebp(env.IMAGES, bytes);
  } catch (err) {
    // A failure that does not blame the file (images.ts) is ours: the row is released, as P4-14 rules.
    await cleanUp("release", ids, release(env.DB, id));
    throw err;
  }
  if (still === null) {
    // The transform ran and gave no WebP to store: the file made it fail, it answered another format (P4-15 b), or
    // its WebP could not be measured (P4-21 item 2). Counted like an upload deleted at once (P4-14): the 150 total cap
    // bounds these too; the row has no object and is never shown.
    await cleanUp("mark_failed", ids, markFailed(env.DB, id, Date.now()));
    throw unreadablePhoto();
  }
  const photo: StoredPhoto = { id, width: still.width, height: still.height, bytes: still.webp.byteLength, createdAt: reservedAt };
  const key = mediaKey(siteId, id);
  try {
    // Before the row is finished, so a finished photo row never lacks its object.
    await env.MEDIA.put(key, still.webp, { httpMetadata: { contentType: "image/webp" }, customMetadata: { siteId, uploadId: id } });
  } catch (err) {
    await cleanUp("release", ids, release(env.DB, id));
    throw err;
  }
  if (!(await finishPhoto(env.DB, id, photo))) {
    // The reservation was lost meanwhile: aged out, marked deleted by a takedown's purge, or its site taken down. Its
    // object goes, and its row becomes a counted failure at once (a no-op once aged out; a purge's deletion time is
    // kept). The upload fails loud (DECIDED P4-21): as a takedown answers when the site is down, else as our failure,
    // with its own line, since this work can outlive the request's one line.
    await cleanUp("media_delete", ids, env.MEDIA.delete(key));
    await cleanUp("mark_failed", ids, markFailed(env.DB, id, Date.now()));
    const takenDown = await isTakenDown(env.DB, siteId);
    logLine({ event: "upload_reservation_lost", uploadId: id, siteId, code: takenDown ? "site_taken_down" : "internal" });
    if (takenDown) throw siteTakenDown();
    throw new Error("upload reservation lost before the photo was stored");
  }
  return photo;
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
    // A taken-down site is frozen: no image work and no storage for it (decision 39). The reservation and the finish
    // check again, since the body below arrives at the owner's pace.
    assertNotTakenDown(site);
    // Pre-check, before the body is read, so an upload the caps refuse costs no body read and no image work. It does
    // not keep the caps exact: uploads whose bodies arrive late all pass it together (the attack P4-21 fixes). The
    // INSERT that reserves the upload's row does, before any billed call (reserveTransformAndStore).
    if (!(await underCaps(db, site.id, Date.now()))) throw limitReached();

    const body = await readBytes(c.req.raw, LIMITS.uploadMaxBytes + MULTIPART_OVERHEAD_BYTES);
    // Before the parse, which walks every part and every header byte (P4-15 d): a Content-Type other than the
    // browser's form (its boundary could be read otherwise, or be long enough to slow the parser's search), more
    // parts than an upload has, or a header that runs on for kilobytes, would only make it slow while the
    // isolate's other requests wait.
    const boundary = multipartBoundary(contentType);
    const shape = boundary === null ? "boundary_not_accepted" : multipartShapeProblem(body, boundary);
    if (shape !== null) {
      noteLog(c, { event: "multipart_refused", reason: shape });
      throw uploadDidNotWork();
    }
    const form = await readForm(c, contentType, body);
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

    // The .info() above is not billed (developers.cloudflare.com/images/pricing/), so the transform is the first
    // billed call. From the reservation that counts it to the row's final state, the work runs as one runToEnd (P4-8,
    // P4-21): should the client go away, waitUntil keeps it going for up to 30 s more ("waitUntil() can extend
    // execution for up to 30 seconds after the response is sent or the client disconnects",
    // developers.cloudflare.com/workers/platform/limits/). Work that outlasts them leaves its reservation counted
    // until it is aged out into a counted failure (Task 27 measures it).
    const photo = await runToEnd(c.executionCtx, reserveTransformAndStore(c.env, site.id, bytes));
    const view: UploadView = {
      id: photo.id,
      url: mediaUrl(c.env.ROOT_DOMAIN, site.id, photo.id),
      width: photo.width,
      height: photo.height,
      bytes: photo.bytes,
      createdAt: photo.createdAt,
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
