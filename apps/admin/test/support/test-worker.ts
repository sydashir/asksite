import { newId } from "@asksite/core";
import { Facts, SiteDocument } from "@asksite/site-schema";
import { Hono } from "hono";
import { createLocalJWKSet, type JSONWebKeySet } from "jose";
import { errorName, fakeAiDraft, fakePublishing } from "../../../app/test/support/fakes.ts";
import { createAdminWorker } from "../../src/worker/worker.ts";
import { withClock } from "./clock.ts";
import { fakeAdminDeps } from "./fakes.ts";

// The admin Worker wired to test fakes. Access tokens are checked against a key the test makes
// (TEST_ACCESS_JWKS), instead of Cloudflare's key endpoint. /__test/sites creates an owner with a
// site waiting for review. Never deployed; helpers answer 404 off *.localhost.
type TestEnv = Env & { TEST_ACCESS_JWKS?: string };

const worker = createAdminWorker(fakeAdminDeps, (env) => createLocalJWKSet(JSON.parse((env as TestEnv).TEST_ACCESS_JWKS ?? '{"keys":[]}') as JSONWebKeySet));

// The waitUntil count below is lane A's seam (apps/app/test/support/test-worker.ts:16-35 and its /__test/wait-until
// route), copied as the moderator ruled for the approve route's runToEnd (web-maker-f4, 2026-09-30).

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

/** The test-only hooks below work only in local development, on a *.localhost host. */
function isLocalTest(request: Request, env: TestEnv): boolean {
  const host = new URL(request.url).hostname;
  return env.ENVIRONMENT === "development" && (host === "localhost" || host.endsWith(".localhost"));
}

const helpers = new Hono<{ Bindings: TestEnv }>();
helpers.use("*", async (c, next) => {
  if (!isLocalTest(c.req.raw, c.env)) return c.notFound();
  await next();
});

/** An owner whose site (with these facts) was built and sent for review. */
helpers.post("/__test/sites", async (c) => {
  const input = await c.req.json<{ email: string; slug: string; facts: unknown; reviewsAreReal?: boolean }>();
  const facts = Facts.parse(input.facts);
  const db = c.env.DB;
  const now = Date.now();
  const ownerId = newId();
  const siteId = newId();
  const generationId = newId();
  const draft = fakeAiDraft(facts);
  await db.batch([
    db.prepare("INSERT INTO owners (id, email, created_at) VALUES (?, ?, ?)").bind(ownerId, input.email, now),
    db.prepare("INSERT INTO sites (id, owner_id, slug, facts_json, brief_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(siteId, ownerId, input.slug, JSON.stringify(facts), JSON.stringify({ tone: "friendly", goal: "call", reviewsAreReal: input.reviewsAreReal ?? false }), now, now),
    db.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, output_json, created_at, finished_at) VALUES (?, ?, ?, 'first', 'succeeded', '{}', ?, ?, ?)")
      .bind(generationId, siteId, ownerId, JSON.stringify(draft), now, now),
  ]);
  const edits = { baseGenerationId: generationId, copy: { ctaText: "Call Joe today" }, order: null, hidden: ["faq" as const], theme: null };
  const document = SiteDocument.parse({ facts, ...draft, copy: { ...draft.copy, ctaText: "Call Joe today" }, hidden: edits.hidden });
  const version = await fakePublishing.createPendingVersion(c.env, { siteId, ownerId, slug: input.slug, document, edits, generationId, now });
  const row = await db.prepare("SELECT html_sha256 FROM site_versions WHERE id = ?").bind(version.id).first<{ html_sha256: string }>();
  return c.json({ ownerId, siteId, versionId: version.id, htmlSha256: row?.html_sha256 });
});

// The Worker's types declare no `process` (tsconfig.worker.json has no Node types), so the probe below
// declares it for this file only; the bundler erases the declaration and the name is looked up in the runtime.
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

/**
 * How many promises requests to a path handed to ctx.waitUntil, and how many still run. Lane A found that a client
 * disconnect cannot be tested instead: the local runtime finishes a request's work after its client has gone, with
 * or without waitUntil (measured 2026-09-26).
 */
helpers.get("/__test/wait-until", (c) => c.json(waitUntilSeen.get(c.req.query("path") ?? "") ?? { count: 0, pending: 0 }));

/**
 * A race seam for the sign-in link: the owner is disabled by a second admin at the moment the token is about to be
 * written, after the route has read the owner. The wrapped D1 runs that disable first, in the same place the race
 * would, so only the INSERT's own "not disabled" condition can refuse the link. Every other call passes through.
 */
function disablingBeforeTokenInsert(db: D1Database, ownerId: string): D1Database {
  const wrapBound = (bound: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(bound, {
      get(target, key) {
        if (key === "run") {
          return async () => {
            await db.prepare("UPDATE owners SET disabled_at = ?, disabled_reason = 'raced' WHERE id = ?").bind(Date.now(), ownerId).run();
            return target.run();
          };
        }
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrapBound(target.bind(...values));
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => (sql.startsWith("INSERT INTO login_tokens") ? wrapStatement(target.prepare(sql)) : target.prepare(sql));
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The faults a takedown request can be given (header X-Test-Takedown-Fault), each thrown as a plain Error, never a PublishError. */
type TakedownFault = "live-delete" | "live-delete-once" | "live-delete-reread" | "before-commit";

/**
 * A fault seam for the takedown's post-commit path. "live-delete" fails LIVE.delete, which real takeDown runs AFTER its
 * D1 batch committed; "live-delete-once" fails only the first LIVE.delete of the request (the route's retry succeeds);
 * "live-delete-reread" also fails the route's re-read of taken_down_at; "before-commit" fails the
 * D1 batch itself, so the site stays up. Every other call passes through.
 */
function withTakedownFault(env: TestEnv, fault: TakedownFault): TestEnv {
  const passThrough = <T extends object>(target: T, key: string | symbol): unknown => {
    const value: unknown = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  };
  let deletes = 0;
  const live = new Proxy(env.LIVE, {
    get(target, key) {
      if (key !== "delete" || fault === "before-commit") return passThrough(target, key);
      deletes += 1;
      return fault === "live-delete-once" && deletes > 1 ? passThrough(target, key) : () => Promise.reject(new Error("LIVE delete failed"));
    },
  });
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === "batch" && fault === "before-commit") return () => Promise.reject(new Error("D1 batch failed"));
      if (key === "prepare" && fault === "live-delete-reread") {
        return (sql: string) => {
          if (sql.startsWith("SELECT taken_down_at FROM sites")) throw new Error("D1 read failed");
          return target.prepare(sql);
        };
      }
      return passThrough(target, key);
    },
  });
  return { ...env, DB: db, LIVE: live };
}

export default {
  fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/__test/")) return helpers.fetch(request, env, ctx);
    const local = isLocalTest(request, env);
    // X-Test-Disable-Owner-Before-Token: <owner id> runs the race seam above for this request only.
    const raced = local ? request.headers.get("X-Test-Disable-Owner-Before-Token") : null;
    const fault = local ? (request.headers.get("X-Test-Takedown-Fault") as TakedownFault | null) : null;
    const requestEnv = raced !== null ? { ...env, DB: disablingBeforeTokenInsert(env.DB, raced) } : fault !== null ? withTakedownFault(env, fault) : env;
    // X-Test-Now pins Date.now() while the Worker handles this request (./clock.ts).
    return withClock(request, local, async () => worker.fetch!(request, requestEnv, counting(ctx, path)));
  },
} satisfies ExportedHandler<TestEnv>;
