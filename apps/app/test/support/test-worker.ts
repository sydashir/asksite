import { ApiError } from "@asksite/app-common";
import { newId, newToken, sha256Hex, TTL } from "@asksite/core";
import { TAKEDOWN_REVIEW_NOTE } from "@asksite/publishing";
import { Hono } from "hono";
import type { Siteverify } from "../../src/worker/deps.ts";
import { requireTurnstile, SITEVERIFY_TIMEOUT_MS } from "../../src/worker/turnstile.ts";
import type { AppEnv } from "../../src/worker/types.ts";
import { createWorker } from "../../src/worker/worker.ts";
import { calledLikeFetch, errorName, fakeApprove, fakeCreateMailer, fakeGeneration, fakePublishing, fakeReject, fakeSiteverify, fetchCalledOn, finishGeneration, refuseNextGeneration, siteverifyCallsSoFar } from "./fakes.ts";
import { PURGE_UPLOADS_SQL, RESTORE_SITE_SQL, TAKE_DOWN_SITE_SQL, TAKE_DOWN_VERSIONS_SQL } from "./plan2b-statements.ts";

// The app Worker wired to the fakes, plus /__test/* helpers that stand in for the admin and the
// generator in tests. Used by the Worker tests (test/wrangler.test.jsonc) and the browser tests
// (test/e2e/wrangler.e2e.jsonc). Never deployed: both configs are test files, and every helper
// answers 404 unless ENVIRONMENT is "development" on a *.localhost host name.
const worker = createWorker({ generation: fakeGeneration, publishing: fakePublishing, createMailer: fakeCreateMailer, siteverify: calledLikeFetch(fakeSiteverify) });

/** Per path: how many promises its requests handed to ctx.waitUntil, and how many of those are still running. */
const waitUntilSeen = new Map<string, { count: number; pending: number }>();

/** The request's ExecutionContext, keeping count of its waitUntil promises by path. */
function counting(ctx: ExecutionContext, path: string): ExecutionContext {
  return new Proxy(ctx, {
    get(target, key) {
      if (key === "waitUntil") {
        return (promise: Promise<unknown>) => {
          const seen = waitUntilSeen.get(path) ?? { count: 0, pending: 0 };
          waitUntilSeen.set(path, seen);
          seen.count += 1;
          seen.pending += 1;
          const done = () => {
            seen.pending -= 1;
          };
          promise.then(done, done);
          target.waitUntil(promise);
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * A step of an upload whose result the test Worker can note: the transform's .output(), an uploads INSERT (the
 * reservation), the MEDIA.put of the photo, the UPDATE of the upload's own row (the photo finished, or the
 * transform counted as failed), or the uploads DELETE that releases the row after a failure that is ours (P4-21).
 */
type StepName = "output" | "insert" | "put" | "update" | "delete";

/**
 * Per watched path: each step as its result came back, with how many waitUntil promises the path's requests had
 * handed over by then and how many of those still ran. Work that one runToEnd keeps going (P4-8) comes back while
 * its one promise runs; work outside it comes back with none running, or under another promise (P4-15 follow-up 1).
 */
const stepsOf = new Map<string, Array<{ step: StepName; waitUntil: number; pending: number }>>();

/** Notes the step for the path, if its steps are watched. */
function noteStep(path: string, step: StepName): void {
  const steps = stepsOf.get(path);
  if (steps === undefined) return;
  const seen = waitUntilSeen.get(path) ?? { count: 0, pending: 0 };
  steps.push({ step, waitUntil: seen.count, pending: seen.pending });
}

/** The work, noting the step for a watched path once its result (a value or an error) comes back. */
function noted<T>(path: string, step: StepName, work: Promise<T>): Promise<T> {
  if (!stepsOf.has(path)) return work;
  return work.then(
    (value) => {
      noteStep(path, step);
      return value;
    },
    (err: unknown) => {
      noteStep(path, step);
      throw err;
    },
  );
}

/** Owners (by email) to disable just before a request's next D1 batch: an admin's disable that lands between a route's checks and its batch. */
const disableBeforeBatch = new Set<string>();

/**
 * Sites that get a twin of their next stored version right after its batch: a second request of the site, committed
 * before the first one's alert check runs. Per site: when the twin was asked for, or null for a millisecond later.
 */
const twinAfterBatch = new Map<string, number | null>();

/**
 * What a second request of the site commits, as Plan 2's batch does (§7.2): the pending version is superseded and a
 * copy of it, numbered one higher and asked for a millisecond later (or at `requestedAt`: a request that took its
 * time earlier yet committed later), is the new pending one. The number follows commit order, as Plan 2's MAX + 1
 * inside the batch does.
 */
async function storeTwin(db: D1Database, siteId: string, requestedAt: number | null): Promise<void> {
  const twinId = newId();
  await db.batch([
    db.prepare("UPDATE site_versions SET status = 'superseded' WHERE site_id = ? AND status = 'pending'").bind(siteId),
    db
      .prepare(
        `INSERT INTO site_versions (id, site_id, number, status, document_json, document_sha256, edits_json, generation_id,
           html_key, html_sha256, stylesheet_sha256, requested_by, requested_at)
         SELECT ?, site_id, number + 1, 'pending', document_json, document_sha256, edits_json, generation_id,
           html_key, html_sha256, stylesheet_sha256, requested_by, COALESCE(?, requested_at + 1)
         FROM site_versions WHERE site_id = ? ORDER BY number DESC LIMIT 1`,
      )
      .bind(twinId, requestedAt, siteId),
    db.prepare("UPDATE sites SET pending_version_id = ? WHERE id = ?").bind(twinId, siteId),
  ]);
}

/**
 * Sites whose last upload slot is taken just before a request's next uploads INSERT: another upload of the site
 * that lands after the route's pre-check and before its exact INSERT. true: that upload is already deleted (it
 * counts toward the 150 total only); false: it is kept (it counts toward both caps).
 */
const takeSlotBeforeUploadInsert = new Map<string, boolean>();

async function takeLastUploadSlots(db: D1Database): Promise<void> {
  const sites = [...takeSlotBeforeUploadInsert];
  takeSlotBeforeUploadInsert.clear();
  for (const [siteId, deleted] of sites) {
    const now = Date.now();
    await db
      .prepare("INSERT INTO uploads (id, site_id, width, height, bytes, created_at, deleted_at) VALUES (?, ?, 400, 300, 1, ?, ?)")
      .bind(newId(), siteId, now, deleted ? now : null)
      .run();
  }
}

/**
 * How a site's upload reservation is lost (or, for "taken_down", its site is frozen) just before a request's next
 * write of its own uploads row (the UPDATE that finishes it or marks it failed, or the DELETE that releases it), as it
 * would be while the request outlived the 10 minutes or while the admin acted: "aged_out" is the age-out that turns it
 * into a counted failure, "purged" is a takedown's media purge (Plan 2 takeDown's own statement, which leaves it
 * reserved), and "taken_down" is Plan 2 takeDown's own statement for the site (no purge: the site is taken down while
 * the reservation stays as it is).
 */
type LoseReservation = "aged_out" | "purged" | "taken_down";

/** Sites whose upload reservation is lost, as LoseReservation says, just before a request's next write of its own uploads row. */
const loseReservationBeforeRowWrite = new Map<string, LoseReservation>();

/** The reason the "taken_down" arm stores, as the admin's Take down would. */
const TEST_TAKEDOWN_REASON = "Taken down by the test Worker";

/** Runs one pinned statement with its bound values (shared by loseReservations and the takedown seams). */
const run = (db: D1Database, sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values).run();

async function loseReservations(db: D1Database): Promise<void> {
  const sites = [...loseReservationBeforeRowWrite];
  loseReservationBeforeRowWrite.clear();
  for (const [siteId, how] of sites) {
    const now = Date.now();
    if (how === "taken_down") {
      // Pinned to Plan 2B's statements by test/worker/plan2b-statements.test.ts.
      await run(db, TAKE_DOWN_SITE_SQL, now, TEST_TAKEDOWN_REASON, now, siteId);
      continue;
    }
    const sql =
      how === "aged_out"
        ? "UPDATE uploads SET deleted_at = ?, reserved_at = NULL WHERE site_id = ? AND reserved_at IS NOT NULL"
        : PURGE_UPLOADS_SQL;
    await run(db, sql, now, siteId);
  }
}

/** Whether the SQL is an UPDATE of one upload's own row (`WHERE id = ?1`), not of a site's uploads. */
const isOwnUploadUpdate = (sql: string): boolean => /^UPDATE uploads SET\b[\s\S]*\bWHERE id = \?1\b/.test(sql.trimStart());

/**
 * Sites where another tab's save lands right after a request's next write to the site commits (a run() of an
 * UPDATE of sites, or a batch that holds one): the given facts and slug, and rev one higher, as that save would.
 */
const saveAfterSiteWrite = new Map<string, { facts?: unknown; slug?: string | undefined }>();

async function saveOtherTabs(db: D1Database): Promise<void> {
  const saves = [...saveAfterSiteWrite];
  saveAfterSiteWrite.clear();
  for (const [siteId, save] of saves) {
    await db
      .prepare("UPDATE sites SET facts_json = COALESCE(?, facts_json), slug = COALESCE(?, slug), rev = rev + 1, updated_at = ? WHERE id = ?")
      .bind(save.facts === undefined ? null : JSON.stringify(save.facts), save.slug ?? null, Date.now(), siteId)
      .run();
  }
}

/** Per recorded path: the SQL text of every statement its requests prepared, oldest first. */
const sqlOf = new Map<string, string[]>();

/** Per recorded path: how many upload pre-checks (the statement that counts a site's uploads, in its batch) have come back. */
const preChecksDoneOf = new Map<string, number>();

/** Whether the SQL is the upload route's pre-check count (routes/uploads.ts underCaps), not the INSERT that reserves. */
const isUploadPreCheck = (sql: string): boolean => /^SELECT COUNT\(\*\)[\s\S]*\bFROM uploads\b/.test(sql.trimStart());

/** Work done just before or just after a statement runs. */
interface Around {
  before?: () => Promise<void>;
  after?: () => Promise<void>;
}

/** Every statement aroundRun made, with its work, so a batch() that holds one does that work around the batch. */
const aroundOf = new WeakMap<D1PreparedStatement, Around>();

/** The statement, with `around` done around each run() of it or of a statement bound from it. */
function aroundRun(statement: D1PreparedStatement, around: Around): D1PreparedStatement {
  const hooked = new Proxy(statement, {
    get(target, key) {
      if (key === "bind") return (...values: unknown[]) => aroundRun(target.bind(...values), around);
      if (key === "run") {
        return async () => {
          await around.before?.();
          const result = await target.run();
          await around.after?.();
          return result;
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  aroundOf.set(hooked, around);
  return hooked;
}

/** How many of the next sessions DELETEs (sign-out) fail, as a D1 outage would make them. */
let sessionDeletesToFail = 0;

/**
 * The Worker's env for a request to `path`, with a D1 binding that runs the armed hooks: around a route's batch(),
 * disable owners before it and store twins after it; before an uploads INSERT, take the site's last upload slot,
 * and before an UPDATE of an upload's own row or an uploads DELETE, lose the site's reservation; after any of them,
 * note the step if the path is watched; after a write to a site, commit another tab's save of it; and record each
 * statement's SQL text, and count each upload pre-check once it has come back, if the path is recorded.
 */
function withD1Hooks(env: Env, path: string): Env {
  if (
    disableBeforeBatch.size === 0 &&
    twinAfterBatch.size === 0 &&
    takeSlotBeforeUploadInsert.size === 0 &&
    loseReservationBeforeRowWrite.size === 0 &&
    saveAfterSiteWrite.size === 0 &&
    sessionDeletesToFail === 0 &&
    !stepsOf.has(path) &&
    !sqlOf.has(path)
  ) {
    return env;
  }
  const DB = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare") {
        return (sql: string) => {
          sqlOf.get(path)?.push(sql);
          const statement = target.prepare(sql);
          if (sql.trimStart().startsWith("INSERT INTO uploads") && (takeSlotBeforeUploadInsert.size > 0 || stepsOf.has(path))) {
            return aroundRun(statement, { before: () => takeLastUploadSlots(target), after: async () => noteStep(path, "insert") });
          }
          if (isOwnUploadUpdate(sql) && (loseReservationBeforeRowWrite.size > 0 || stepsOf.has(path))) {
            return aroundRun(statement, { before: () => loseReservations(target), after: async () => noteStep(path, "update") });
          }
          if (sql.trimStart().startsWith("DELETE FROM uploads") && (loseReservationBeforeRowWrite.size > 0 || stepsOf.has(path))) {
            return aroundRun(statement, { before: () => loseReservations(target), after: async () => noteStep(path, "delete") });
          }
          if (sessionDeletesToFail > 0 && sql.trimStart().startsWith("DELETE FROM sessions")) {
            return aroundRun(statement, {
              before: async () => {
                if (sessionDeletesToFail === 0) return;
                sessionDeletesToFail -= 1;
                throw new Error("test failure");
              },
            });
          }
          if (saveAfterSiteWrite.size > 0 && sql.trimStart().startsWith("UPDATE sites ")) return aroundRun(statement, { after: () => saveOtherTabs(target) });
          if (sqlOf.has(path) && isUploadPreCheck(sql)) {
            const countDone = async () => {
              preChecksDoneOf.set(path, (preChecksDoneOf.get(path) ?? 0) + 1);
            };
            return aroundRun(statement, { after: countDone });
          }
          return statement;
        };
      }
      if (key === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const emails = [...disableBeforeBatch];
          disableBeforeBatch.clear();
          for (const email of emails) await target.prepare("UPDATE owners SET disabled_at = ? WHERE email = ?").bind(Date.now(), email).run();
          const arounds = statements.flatMap((statement) => aroundOf.get(statement) ?? []);
          for (const around of arounds) await around.before?.();
          const results = await target.batch(statements);
          const twins = [...twinAfterBatch];
          twinAfterBatch.clear();
          for (const [siteId, requestedAt] of twins) await storeTwin(target, siteId, requestedAt);
          for (const around of arounds) await around.after?.();
          return results;
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...env, DB };
}

/** One thing the Worker asked of an Images transformer: the options of a .transform() or of an .output(). */
type ImagesCall = { transform: ImageTransform } | { output: ImageOutputOptions };

/**
 * Every .transform() and .output() the Worker asked of IMAGES, oldest first. The local binding ignores
 * `anim` and `quality` (miniflare's images fetcher never reads them), so tests check what was asked here.
 */
const imagesCalls: ImagesCall[] = [];

/** The two calls of the binding that reach the Images service: .info() reads the image, .output() re-encodes it. */
type ImagesStep = "info" | "output";

/**
 * When set, the nth next call of that step fails instead of doing its work (the calls before it do theirs): with an
 * ImagesError of this code (the shape workerd's binding throws: an Error with a numeric `code`), or with a TypeError
 * when the code is null. An upload's first .info() measures the photo; its second measures the transform's WebP.
 */
let nextImagesFailure: { step: ImagesStep; code: number | null; callsLeft: number } | undefined;

/** The armed failure for this step, if this call is the one it names, disarming it. */
function takeImagesFailure(step: ImagesStep): Error | undefined {
  if (nextImagesFailure?.step !== step) return undefined;
  nextImagesFailure.callsLeft -= 1;
  if (nextImagesFailure.callsLeft > 0) return undefined;
  const { code } = nextImagesFailure;
  nextImagesFailure = undefined;
  return code === null ? new TypeError("Network connection lost.") : Object.assign(new Error(`IMAGES_${step}_ERROR ${code}: made by the test Worker`), { code });
}

/** When set, the next .output() asks the real binding for this format instead of the one the Worker asked for (which is still recorded). */
let nextOutputFormat: ImageOutputOptions["format"] | undefined;

/**
 * The real transformer of a request to `path`, recording the options it is given; its .output() can be made to fail
 * once, or to answer another format once, and is noted as a step when the path is watched.
 */
function recordingTransformer(transformer: ImageTransformer, path: string): ImageTransformer {
  return {
    transform(transform) {
      imagesCalls.push({ transform });
      return recordingTransformer(transformer.transform(transform), path);
    },
    draw(image, options) {
      return recordingTransformer(transformer.draw(image, options), path);
    },
    output(options) {
      imagesCalls.push({ output: options });
      const failure = takeImagesFailure("output");
      if (failure !== undefined) return noted(path, "output", Promise.reject(failure));
      const format = nextOutputFormat ?? options.format;
      nextOutputFormat = undefined;
      return noted(path, "output", transformer.output({ ...options, format }));
    },
  };
}

/** The Worker's env for a request to `path`, with an Images binding that does the real work, records what it is asked and can fail one step once. */
function withImagesHook(env: Env, path: string): Env {
  const images = env.IMAGES;
  const IMAGES: ImagesBinding = {
    info(stream, options) {
      const failure = takeImagesFailure("info");
      return failure === undefined ? images.info(stream, options) : Promise.reject(failure);
    },
    input: (stream, options) => recordingTransformer(images.input(stream, options), path),
    text: (content, options) => recordingTransformer(images.text(content, options), path),
    get hosted() {
      return images.hosted;
    },
  };
  return { ...env, IMAGES };
}

/** When true, the next MEDIA.put of any request fails, as an R2 outage would. */
let nextMediaPutFails = false;

/** When true, the next MEDIA.delete of any request fails, as an R2 outage would. */
let nextMediaDeleteFails = false;

/**
 * The Worker's env for a request to `path`, with a MEDIA binding whose next put() or delete() can be made to fail
 * once, and whose put() is noted as a step, failed or not, when the path is watched.
 */
function withMediaHook(env: Env, path: string): Env {
  if (!nextMediaPutFails && !nextMediaDeleteFails && !stepsOf.has(path)) return env;
  const MEDIA = new Proxy(env.MEDIA, {
    get(target, key) {
      if (key === "put" && nextMediaPutFails) {
        nextMediaPutFails = false;
        return () => noted(path, "put", Promise.reject(new Error("R2 put failed: made by the test Worker")));
      }
      if (key === "delete" && nextMediaDeleteFails) {
        nextMediaDeleteFails = false;
        return () => Promise.reject(new Error("R2 delete failed: made by the test Worker"));
      }
      if (key === "put") return (...args: Parameters<R2Bucket["put"]>) => noted(path, "put", target.put(...args));
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...env, MEDIA };
}

const helpers = new Hono<AppEnv>();

helpers.use("*", async (c, next) => {
  const host = new URL(c.req.url).hostname;
  if (c.env.ENVIRONMENT !== "development" || !(host === "localhost" || host.endsWith(".localhost"))) return c.notFound();
  await next();
});

/** What the admin's "create invite" does, minus the email: returns the token. */
helpers.post("/__test/invites", async (c) => {
  const { email } = await c.req.json<{ email: string }>();
  const token = newToken();
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO invites (id, token_hash, email, created_by, created_at, expires_at) VALUES (?, ?, ?, 'test', ?, ?)")
    .bind(newId(), await sha256Hex(token), email.trim().toLowerCase(), now, now + TTL.inviteMs)
    .run();
  return c.json({ token });
});

/** Arms the hook above for one owner: the next D1 batch of any request disables them first. */
helpers.post("/__test/disable-before-batch", async (c) => {
  const { email } = await c.req.json<{ email: string }>();
  disableBeforeBatch.add(email.trim().toLowerCase());
  return c.json({ ok: true });
});

/**
 * Arms the hook above for one site: right after the next D1 batch of any request, a second request of the site is
 * committed (storeTwin), asked for at `requestedAt` if given.
 */
helpers.post("/__test/twin-after-batch", async (c) => {
  const { siteId, requestedAt } = await c.req.json<{ siteId: string; requestedAt?: number }>();
  twinAfterBatch.set(siteId, requestedAt ?? null);
  return c.json({ ok: true });
});

/** Arms the hook above for one site: just before the next uploads INSERT of any request, another upload takes its last slot. */
helpers.post("/__test/take-last-upload-slot", async (c) => {
  const { siteId, deleted } = await c.req.json<{ siteId: string; deleted: boolean }>();
  takeSlotBeforeUploadInsert.set(siteId, deleted);
  return c.json({ ok: true });
});

/**
 * Arms the hook above for one site: just before the next write of an upload's own row of any request, the site's
 * reservation is lost (aged out or purged), or the site is taken down.
 */
helpers.post("/__test/lose-upload-reservation", async (c) => {
  const { siteId, how } = await c.req.json<{ siteId: string; how: LoseReservation }>();
  loseReservationBeforeRowWrite.set(siteId, how);
  return c.json({ ok: true });
});

/** Arms the hook above for one site: right after the next write to it of any request, another tab's save of it is committed. */
helpers.post("/__test/save-after-site-write", async (c) => {
  const { siteId, facts, slug } = await c.req.json<{ siteId: string; facts?: unknown; slug?: string }>();
  saveAfterSiteWrite.set(siteId, { facts, slug });
  return c.json({ ok: true });
});

/** Arms the fake generator: its next request is refused with this code, whatever the site's state. */
helpers.post("/__test/generation-refuses", async (c) => {
  const { code } = await c.req.json<{ code: Parameters<typeof refuseNextGeneration>[0] }>();
  refuseNextGeneration(code);
  return c.json({ ok: true });
});

/** What the generator does when a job ends. */
helpers.post("/__test/generations/:generationId/finish", async (c) => {
  const body = await c.req.json<{ status: "succeeded" | "failed"; usedFallback?: boolean }>();
  const outcome = body.status === "failed" ? { status: "failed" as const, errorCode: "provider_unavailable" as const } : { status: "succeeded" as const, usedFallback: body.usedFallback === true };
  const finished = await finishGeneration(c.env.DB, c.req.param("generationId"), outcome, Date.now());
  return finished ? c.json({ ok: true }) : c.notFound();
});

/** What the sites Worker's contact form stores (Plan 2): one lead per call. */
helpers.post("/__test/sites/:siteId/leads", async (c) => {
  const lead = await c.req.json<{ name: string; phone: string; email?: string; service?: string; message?: string; emailStatus?: "pending" | "sent" | "failed" | "skipped"; createdAt?: number }>();
  await c.env.DB.prepare(
    `INSERT INTO leads (id, site_id, created_at, name, phone, email, service, message, spam, email_status, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'test')`,
  )
    .bind(newId(), c.req.param("siteId"), lead.createdAt ?? Date.now(), lead.name, lead.phone, lead.email ?? null, lead.service ?? null, lead.message ?? null, lead.emailStatus ?? "sent")
    .run();
  return c.json({ ok: true });
});

/** What the fake siteverify has been sent, oldest first. */
helpers.get("/__test/siteverify", (c) => c.json(siteverifyCallsSoFar()));

/** What the Worker has asked of IMAGES so far, oldest first (see imagesCalls). */
helpers.get("/__test/images-calls", (c) => c.json(imagesCalls));

/** Arms the hook above: the nth (default: the first) next IMAGES .info() or .output() of any request fails with this code (null: a TypeError). */
helpers.post("/__test/images-fails", async (c) => {
  const { step, code, nth } = await c.req.json<{ step: ImagesStep; code: number | null; nth?: number }>();
  nextImagesFailure = { step, code, callsLeft: nth ?? 1 };
  return c.json({ ok: true });
});

/** Arms the hook above: the next IMAGES .output() of any request answers this format, as if the service had not made a WebP. */
helpers.post("/__test/images-output-format", async (c) => {
  const { format } = await c.req.json<{ format: ImageOutputOptions["format"] }>();
  nextOutputFormat = format;
  return c.json({ ok: true });
});

/** Arms the hook above: the next `times` (default 1) sessions DELETEs of any request fail. */
helpers.post("/__test/session-delete-fails", async (c) => {
  const { times } = await c.req.json<{ times?: number }>();
  sessionDeletesToFail = times ?? 1;
  return c.json({ ok: true });
});

/** Arms the hook above: the next MEDIA.put of any request fails. */
helpers.post("/__test/media-put-fails", (c) => {
  nextMediaPutFails = true;
  return c.json({ ok: true });
});

/** Arms the hook above: the next MEDIA.delete of any request fails. */
helpers.post("/__test/media-delete-fails", (c) => {
  nextMediaDeleteFails = true;
  return c.json({ ok: true });
});

/**
 * How many promises requests to a path handed to ctx.waitUntil, and how many still run. A client
 * disconnect cannot be tested here instead: the local runtime finishes a request's work after its
 * client has gone, with or without waitUntil (measured 2026-09-26).
 */
helpers.get("/__test/wait-until", (c) => c.json(waitUntilSeen.get(c.req.query("path") ?? "") ?? { count: 0, pending: 0 }));

/** Arms the step notes above for one path: from now on, its requests note each .output(), uploads INSERT, MEDIA.put, UPDATE of an upload's own row and uploads DELETE as its result comes back. */
helpers.post("/__test/watch-steps", async (c) => {
  const { path } = await c.req.json<{ path: string }>();
  stepsOf.set(path, []);
  return c.json({ ok: true });
});

/** The steps noted for a watched path, oldest first (see stepsOf). */
helpers.get("/__test/steps", (c) => c.json(stepsOf.get(c.req.query("path") ?? "") ?? []));

/** Starts recording for one path, afresh: from now on, the SQL text of each statement its requests prepare (see sqlOf). */
helpers.post("/__test/record-sql", async (c) => {
  const { path } = await c.req.json<{ path: string }>();
  sqlOf.set(path, []);
  preChecksDoneOf.set(path, 0);
  return c.json({ ok: true });
});

/** The SQL text recorded for a path, oldest first (see sqlOf). */
helpers.get("/__test/sql", (c) => c.json(sqlOf.get(c.req.query("path") ?? "") ?? []));

/** How many upload pre-checks of a recorded path have come back since its recording started (see preChecksDoneOf). */
helpers.get("/__test/pre-checks-done", (c) => c.json(preChecksDoneOf.get(c.req.query("path") ?? "") ?? 0));

// The Worker's types have no `process` (Node.js compatibility is off), so the probe below declares it
// for this file only; the bundler erases the declaration and the name is looked up in the runtime.
declare const process: unknown;

/**
 * A13: whether node:process can be imported inside this Worker, and if so, which names its env holds and
 * which of this Worker's binding names can be read from it (names only, never values). The specifier is a
 * variable, so the bundler leaves the import to the runtime.
 */
async function nodeProcessEnv(bindingNames: string[]) {
  const specifier = "node:process";
  let env: Record<string, unknown>;
  try {
    const imported = (await import(specifier)) as { env?: unknown; default?: { env?: unknown } };
    env = (imported.env ?? imported.default?.env ?? {}) as Record<string, unknown>;
  } catch (err) {
    return { importable: false, error: errorName(err) };
  }
  return { importable: true, envKeys: Reflect.ownKeys(env).map(String), readable: bindingNames.filter((name) => env[name] !== undefined), checked: bindingNames };
}

/** A13: what `typeof process` is inside this Worker ("undefined" once Node.js compatibility is off), and what node:process gives. */
helpers.get("/__test/runtime", async (c) => c.json({ process: typeof process, nodeProcess: await nodeProcessEnv(Object.keys(c.env)) }));

/** What workerd's global fetch does called as a plain function, and as a method of another object (siteverify's receiver check). */
helpers.get("/__test/fetch-receiver", async (c) => {
  const asMethod = await fetchCalledOn({ fetch });
  return c.json({ plain: errorName(await fetchCalledOn(undefined)), asMethod: `${errorName(asMethod)}: ${asMethod instanceof Error ? asMethod.message : ""}` });
});

/**
 * The Turnstile check against a siteverify that never answers, with the timeout the query names instead of
 * production's (which it reports): what the check decided, how many calls it made, and whether each was abandoned.
 */
helpers.post("/__test/turnstile-never", async (c) => {
  const signals: AbortSignal[] = [];
  const never: Siteverify = (_url, init) => {
    signals.push(init.signal);
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  };
  const refused = await requireTurnstile(c, never, Number(c.req.query("timeoutMs"))).then(
    () => null,
    (err: unknown) => (err instanceof ApiError ? err.code : "other"),
  );
  return c.json({ refused, calls: signals.length, abandoned: signals.map((signal) => signal.aborted), defaultTimeoutMs: SITEVERIFY_TIMEOUT_MS });
});

/** What the admin's approval does to D1. */
helpers.post("/__test/versions/:versionId/approve", async (c) => c.json(await fakeApprove(c.env, c.req.param("versionId"), Date.now())));

/** What the admin's Reject does to D1. */
helpers.post("/__test/versions/:versionId/reject", async (c) => {
  const { note } = await c.req.json<{ note: string }>();
  return c.json(await fakeReject(c.env, c.req.param("versionId"), note, Date.now()));
});

/** What the admin's Take down does to D1: Plan 2B's two statements in its order, versions then site. */
helpers.post("/__test/sites/:siteId/take-down", async (c) => {
  const now = Date.now();
  const siteId = c.req.param("siteId");
  await run(c.env.DB, TAKE_DOWN_VERSIONS_SQL, "test-admin", now, TAKEDOWN_REVIEW_NOTE, siteId);
  await run(c.env.DB, TAKE_DOWN_SITE_SQL, now, TEST_TAKEDOWN_REASON, now, siteId);
  return c.json({ ok: true });
});

/** What the admin's Restore does to the site row (Plan 2B's own statement). */
helpers.post("/__test/sites/:siteId/restore", async (c) => {
  await run(c.env.DB, RESTORE_SITE_SQL, Date.now(), c.req.param("siteId"));
  return c.json({ ok: true });
});

export default {
  fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    return path.startsWith("/__test/") ? helpers.fetch(request, env, ctx) : worker.fetch!(request, withMediaHook(withImagesHook(withD1Hooks(env, path), path), path), counting(ctx, path));
  },
  scheduled(controller, env, ctx) {
    return worker.scheduled!(controller, env, ctx);
  },
} satisfies ExportedHandler<Env>;
