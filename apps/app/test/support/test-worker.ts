import { ApiError } from "@asksite/app-common";
import { newId, newToken, sha256Hex, TTL } from "@asksite/core";
import { Hono } from "hono";
import type { Siteverify } from "../../src/worker/deps.ts";
import { requireTurnstile, SITEVERIFY_TIMEOUT_MS } from "../../src/worker/turnstile.ts";
import type { AppEnv } from "../../src/worker/types.ts";
import { createWorker } from "../../src/worker/worker.ts";
import { calledLikeFetch, errorName, fakeApprove, fakeCreateMailer, fakeGeneration, fakePublishing, fakeSiteverify, fetchCalledOn, finishGeneration, siteverifyCallsSoFar } from "./fakes.ts";

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

/** Owners (by email) to disable just before a request's next D1 batch: an admin's disable that lands between a route's checks and its batch. */
const disableBeforeBatch = new Set<string>();

/** Sites that get a twin of their next stored version right after its batch: a second request of the site, committed before the first one's alert check runs. */
const twinAfterBatch = new Set<string>();

/**
 * What a second request of the site commits, as Plan 2's batch does (§7.2): the pending version is superseded and a
 * copy of it, numbered one higher and asked for a millisecond later, is the new pending one. The number follows
 * commit order, as Plan 2's MAX + 1 inside the batch does.
 */
async function storeTwin(db: D1Database, siteId: string): Promise<void> {
  const twinId = newId();
  await db.batch([
    db.prepare("UPDATE site_versions SET status = 'superseded' WHERE site_id = ? AND status = 'pending'").bind(siteId),
    db
      .prepare(
        `INSERT INTO site_versions (id, site_id, number, status, document_json, document_sha256, edits_json, generation_id,
           html_key, html_sha256, stylesheet_sha256, requested_by, requested_at)
         SELECT ?, site_id, number + 1, 'pending', document_json, document_sha256, edits_json, generation_id,
           html_key, html_sha256, stylesheet_sha256, requested_by, requested_at + 1
         FROM site_versions WHERE site_id = ? ORDER BY number DESC LIMIT 1`,
      )
      .bind(twinId, siteId),
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

/** The statement, with `before` done just before each run() of it or of a statement bound from it. */
function runningFirst(statement: D1PreparedStatement, before: () => Promise<void>): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, key) {
      if (key === "bind") return (...values: unknown[]) => runningFirst(target.bind(...values), before);
      if (key === "run") {
        return async () => {
          await before();
          return target.run();
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * The Worker's env, with a D1 binding that runs the armed hooks: around a route's batch(), disable owners before
 * it and store twins after it; before an uploads INSERT, take the site's last upload slot.
 */
function withD1Hooks(env: Env): Env {
  if (disableBeforeBatch.size === 0 && twinAfterBatch.size === 0 && takeSlotBeforeUploadInsert.size === 0) return env;
  const DB = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          return takeSlotBeforeUploadInsert.size > 0 && sql.trimStart().startsWith("INSERT INTO uploads") ? runningFirst(statement, () => takeLastUploadSlots(target)) : statement;
        };
      }
      if (key === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const emails = [...disableBeforeBatch];
          disableBeforeBatch.clear();
          for (const email of emails) await target.prepare("UPDATE owners SET disabled_at = ? WHERE email = ?").bind(Date.now(), email).run();
          const results = await target.batch(statements);
          const twins = [...twinAfterBatch];
          twinAfterBatch.clear();
          for (const siteId of twins) await storeTwin(target, siteId);
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
 * When set, the next call of that step fails instead of doing its work: with an ImagesError of this code (the
 * shape workerd's binding throws: an Error with a numeric `code`), or with a TypeError when the code is null.
 */
let nextImagesFailure: { step: ImagesStep; code: number | null } | undefined;

/** The armed failure for this step, if any, disarming it. */
function takeImagesFailure(step: ImagesStep): Error | undefined {
  if (nextImagesFailure?.step !== step) return undefined;
  const { code } = nextImagesFailure;
  nextImagesFailure = undefined;
  return code === null ? new TypeError("Network connection lost.") : Object.assign(new Error(`IMAGES_${step}_ERROR ${code}: made by the test Worker`), { code });
}

/** The real transformer, recording the options it is given; its .output() can be made to fail once. */
function recordingTransformer(transformer: ImageTransformer): ImageTransformer {
  return {
    transform(transform) {
      imagesCalls.push({ transform });
      return recordingTransformer(transformer.transform(transform));
    },
    draw(image, options) {
      return recordingTransformer(transformer.draw(image, options));
    },
    output(options) {
      imagesCalls.push({ output: options });
      const failure = takeImagesFailure("output");
      return failure === undefined ? transformer.output(options) : Promise.reject(failure);
    },
  };
}

/** The Worker's env, with an Images binding that does the real work, records what it is asked and can fail one step once. */
function withImagesHook(env: Env): Env {
  const images = env.IMAGES;
  const IMAGES: ImagesBinding = {
    info(stream, options) {
      const failure = takeImagesFailure("info");
      return failure === undefined ? images.info(stream, options) : Promise.reject(failure);
    },
    input: (stream, options) => recordingTransformer(images.input(stream, options)),
    text: (content, options) => recordingTransformer(images.text(content, options)),
    get hosted() {
      return images.hosted;
    },
  };
  return { ...env, IMAGES };
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

/** Arms the hook above for one site: right after the next D1 batch of any request, a second request of the site is committed (storeTwin). */
helpers.post("/__test/twin-after-batch", async (c) => {
  const { siteId } = await c.req.json<{ siteId: string }>();
  twinAfterBatch.add(siteId);
  return c.json({ ok: true });
});

/** Arms the hook above for one site: just before the next uploads INSERT of any request, another upload takes its last slot. */
helpers.post("/__test/take-last-upload-slot", async (c) => {
  const { siteId, deleted } = await c.req.json<{ siteId: string; deleted: boolean }>();
  takeSlotBeforeUploadInsert.set(siteId, deleted);
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
  const lead = await c.req.json<{ name: string; phone: string; email?: string; message?: string; createdAt?: number }>();
  await c.env.DB.prepare(
    `INSERT INTO leads (id, site_id, created_at, name, phone, email, service, message, spam, email_status, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, 'sent', 'test')`,
  )
    .bind(newId(), c.req.param("siteId"), lead.createdAt ?? Date.now(), lead.name, lead.phone, lead.email ?? null, lead.message ?? null)
    .run();
  return c.json({ ok: true });
});

/** What the fake siteverify has been sent, oldest first. */
helpers.get("/__test/siteverify", (c) => c.json(siteverifyCallsSoFar()));

/** What the Worker has asked of IMAGES so far, oldest first (see imagesCalls). */
helpers.get("/__test/images-calls", (c) => c.json(imagesCalls));

/** Arms the hook above: the next IMAGES .info() or .output() of any request fails with this code (null: a TypeError). */
helpers.post("/__test/images-fails", async (c) => {
  const { step, code } = await c.req.json<{ step: ImagesStep; code: number | null }>();
  nextImagesFailure = { step, code };
  return c.json({ ok: true });
});

/**
 * How many promises requests to a path handed to ctx.waitUntil, and how many still run. A client
 * disconnect cannot be tested here instead: the local runtime finishes a request's work after its
 * client has gone, with or without waitUntil (measured 2026-09-26).
 */
helpers.get("/__test/wait-until", (c) => c.json(waitUntilSeen.get(c.req.query("path") ?? "") ?? { count: 0, pending: 0 }));

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

export default {
  fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    return path.startsWith("/__test/") ? helpers.fetch(request, env, ctx) : worker.fetch!(request, withImagesHook(withD1Hooks(env)), counting(ctx, path));
  },
  scheduled(controller, env, ctx) {
    return worker.scheduled!(controller, env, ctx);
  },
} satisfies ExportedHandler<Env>;
