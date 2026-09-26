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

/** The Worker's env, with a D1 binding that first disables those owners when a route calls batch(). */
function withBatchHook(env: Env): Env {
  if (disableBeforeBatch.size === 0) return env;
  const DB = new Proxy(env.DB, {
    get(target, key) {
      if (key === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const emails = [...disableBeforeBatch];
          disableBeforeBatch.clear();
          for (const email of emails) await target.prepare("UPDATE owners SET disabled_at = ? WHERE email = ?").bind(Date.now(), email).run();
          return target.batch(statements);
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

/** The real transformer, recording the options it is given. */
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
      return transformer.output(options);
    },
  };
}

/**
 * When set, the next IMAGES.info() fails instead of reading the image: with an ImagesError of this code (the
 * shape workerd's binding throws: an Error with a numeric `code`), or with a TypeError when the code is null.
 */
let nextInfoFailure: { code: number | null } | undefined;

function infoFailure(code: number | null): Error {
  return code === null ? new TypeError("Network connection lost.") : Object.assign(new Error(`IMAGES_INFO_ERROR ${code}: made by the test Worker`), { code });
}

/** The Worker's env, with an Images binding that does the real work, records what it is asked and can fail .info() once. */
function withImagesHook(env: Env): Env {
  const images = env.IMAGES;
  const IMAGES: ImagesBinding = {
    info(stream, options) {
      const failure = nextInfoFailure;
      nextInfoFailure = undefined;
      return failure === undefined ? images.info(stream, options) : Promise.reject(infoFailure(failure.code));
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

/** Arms the hook above: the next IMAGES.info() of any request fails with this code (null: a TypeError). */
helpers.post("/__test/images-info-fails", async (c) => {
  const { code } = await c.req.json<{ code: number | null }>();
  nextInfoFailure = { code };
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
    return path.startsWith("/__test/") ? helpers.fetch(request, env, ctx) : worker.fetch!(request, withImagesHook(withBatchHook(env)), counting(ctx, path));
  },
  scheduled(controller, env, ctx) {
    return worker.scheduled!(controller, env, ctx);
  },
} satisfies ExportedHandler<Env>;
