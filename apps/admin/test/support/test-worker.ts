import { livePageKey, livePointerKey, newId } from "@asksite/core";
import { Facts, SiteDocument } from "@asksite/site-schema";
import { Hono } from "hono";
import { createLocalJWKSet, type JSONWebKeySet } from "jose";
import { errorName, fakeAiDraft, fakePublishing } from "../../../app/test/support/fakes.ts";
import { createAdminWorker } from "../../src/worker/worker.ts";
import { withClock } from "./clock.ts";
import { fakeAdminDeps, fakeAdminPublishing } from "./fakes.ts";

// The admin Worker wired to test fakes. Access tokens are checked against a key the test makes
// (TEST_ACCESS_JWKS), instead of Cloudflare's key endpoint. /__test/sites creates an owner with a
// site waiting for review. Never deployed; helpers answer 404 off *.localhost.
type TestEnv = Env & { TEST_ACCESS_JWKS?: string };

const worker = createAdminWorker(fakeAdminDeps, (env) => createLocalJWKSet(JSON.parse((env as TestEnv).TEST_ACCESS_JWKS ?? '{"keys":[]}') as JSONWebKeySet));

/** An address the owner's approval email refuses (not https): what a Plan 2 that answered a bad live address would give. */
const UNSAFE_LIVE_URL = "http://unsafe.example/";

/** The same Worker whose approve answers UNSAFE_LIVE_URL (header X-Test-Unsafe-Live-Url): the approval itself is the fake's, unchanged. */
const unsafeUrlWorker = createAdminWorker(
  {
    ...fakeAdminDeps,
    publishing: { ...fakeAdminPublishing, approveVersion: async (env, input) => ({ ...(await fakeAdminPublishing.approveVersion(env, input)), liveUrl: UNSAFE_LIVE_URL }) },
  },
  (env) => createLocalJWKSet(JSON.parse((env as TestEnv).TEST_ACCESS_JWKS ?? '{"keys":[]}') as JSONWebKeySet),
);

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

/**
 * What the sites Worker would find in LIVE for a slug: the pointer's version id (null when there is no pointer: every page is then
 * "not found") and whether that version's home page is stored under its own LIVE key. There is no sites Worker in these e2e runs, so
 * this reads the same two objects it reads (pointer, then page), nothing else.
 */
helpers.get("/__test/live/:slug", async (c) => {
  const slug = c.req.param("slug");
  const pointer = await c.env.LIVE.head(livePointerKey(slug));
  const versionId = pointer?.customMetadata?.["versionId"] ?? null;
  const home = versionId === null ? null : await c.env.LIVE.head(livePageKey(slug, versionId, "home"));
  return c.json({ pointerVersionId: versionId, homeStored: home !== null });
});

/** The mails the dev outbox holds for an address (the fake mailer writes there), as tags: lets an e2e count the owner's notices. */
helpers.get("/__test/outbox", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT tag FROM dev_outbox WHERE to_addr = ?").bind(c.req.query("to") ?? "").all<{ tag: string }>();
  return c.json(results);
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

/**
 * A timing seam for two admins acting on one site: the request's lease acquire (the UPDATE sites SET admin_lock ... of
 * Plan 2's acquireLease, the first statement of takeDown under the lease) waits this long first, as a slow D1 round-trip
 * would, so the route's earlier read of the site can predate another admin's commit. Nothing else changes.
 */
function delayingLease(db: D1Database, ms: number): D1Database {
  const delayed = (bound: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(bound, {
      get(target, key) {
        if (key === "run") {
          return async () => {
            await new Promise((resolve) => setTimeout(resolve, ms));
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
        if (key === "bind") return (...values: unknown[]) => delayed(target.bind(...values));
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => (sql.startsWith("UPDATE sites SET admin_lock = ?, admin_lock_until = ?") ? wrapStatement(target.prepare(sql)) : target.prepare(sql));
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The faults a request can be given (header X-Test-Takedown-Fault), each thrown as a plain Error, never a PublishError. */
type TakedownFault = "pointer-delete" | "before-commit" | "prefix-delete" | "prefix-delete-once" | "prefix-delete-reread" | "pointer-write" | "lease-lost-after-batch" | "lease-lost-after-batch-reread" | "lease-lost-before-batch-reread" | "reread-only" | "lease-lost-before-batch" | "lease-taken-over-before-batch";

/** The site an admin request acts on: /sites/<id>/... names it, /versions/<id>/... names a version whose site is looked up. null: neither. */
async function requestSiteId(db: D1Database, path: string): Promise<string | null> {
  const site = /\/sites\/([^/]+)\//.exec(path)?.[1];
  if (site !== undefined) return site;
  const version = /\/versions\/([^/]+)\//.exec(path)?.[1];
  if (version === undefined) return null;
  return (await db.prepare("SELECT site_id FROM site_versions WHERE id = ?").bind(version).first<{ site_id: string }>())?.site_id ?? null;
}

/**
 * Faults at the real failure points of Plan 2's takeDown order (pointer delete, D1 batch, prefix delete) and of approve's
 * pointer write. "pointer-delete" fails every LIVE.delete of a single key (the pointer: step 1, before anything changed in D1);
 * "before-commit" fails the D1 batch itself (the pointer is already gone, the site stays up in D1); "prefix-delete" fails every
 * LIVE.delete of a list of keys (the prefix delete, which runs AFTER the D1 batch committed); "prefix-delete-once" fails only
 * the first of them (the route's retry succeeds); "prefix-delete-reread" is "prefix-delete" and also fails the route's re-read
 * of taken_down_at; "pointer-write" fails the LIVE.put of a pointer (a key with no "/"), which approve reports as live_copy_failed.
 * "lease-lost-after-batch" runs the D1 batch and then frees the admin lease of the site the request acts on (and only that site), as an
 * action that ran past its lease would find it (approve then answers lease_lost with the approval committed and no pointer written; a
 * takedown, with the takedown committed and its LIVE clean-up not done). "lease-lost-after-batch-reread" is that and also fails the route's
 * re-read of taken_down_at (the double fault: no notice is sent, the 409 says noticeSent false). "lease-lost-before-batch-reread" is the same
 * with the lease lost BEFORE the batch (the site stays up). "reread-only" fails only the route's re-read: takeDown returns normally (the
 * toward-sending fallback). "lease-lost-before-batch" frees that lease BEFORE the D1 batch
 * runs (a restore whose clear is then fenced out: 0 rows changed). "lease-taken-over-before-batch" does the same as another action
 * would: it gives the lease to "another-call" and overwrites the pointer with one that action wrote (writer "another-call").
 * Every other call passes through.
 */
function withFault(env: TestEnv, fault: TakedownFault, path: string): TestEnv {
  const passThrough = <T extends object>(target: T, key: string | symbol): unknown => {
    const value: unknown = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  };
  let prefixDeletes = 0;
  const live = new Proxy(env.LIVE, {
    get(target, key) {
      if (key === "put" && fault === "pointer-write") {
        return (name: string, ...rest: [unknown, unknown?]) => (name.includes("/") ? (target.put as (...args: unknown[]) => Promise<unknown>)(name, ...rest) : Promise.reject(new Error("LIVE pointer write failed")));
      }
      if (key !== "delete") return passThrough(target, key);
      return (keys: string | string[]) => {
        const several = Array.isArray(keys);
        if (fault === "pointer-delete" && !several) return Promise.reject(new Error("LIVE delete failed"));
        if (several && (fault === "prefix-delete" || fault === "prefix-delete-reread" || (fault === "prefix-delete-once" && (prefixDeletes += 1) === 1))) {
          return Promise.reject(new Error("LIVE delete failed"));
        }
        return target.delete(keys as string);
      };
    },
  });
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === "batch" && fault === "before-commit") return () => Promise.reject(new Error("D1 batch failed"));
      if (key === "batch" && (fault === "lease-lost-after-batch" || fault === "lease-lost-after-batch-reread")) {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          // Only the site the request acts on (an approve names a version, the others a site): another site's lease must stay held.
          const siteId = await requestSiteId(target, path);
          await target.prepare("UPDATE sites SET admin_lock = NULL, admin_lock_until = NULL WHERE id = ?").bind(siteId).run();
          return results;
        };
      }
      if (key === "batch" && (fault === "lease-lost-before-batch" || fault === "lease-lost-before-batch-reread" || fault === "lease-taken-over-before-batch")) {
        return async (statements: D1PreparedStatement[]) => {
          const siteId = await requestSiteId(target, path);
          if (fault === "lease-lost-before-batch" || fault === "lease-lost-before-batch-reread") {
            await target.prepare("UPDATE sites SET admin_lock = NULL, admin_lock_until = NULL WHERE id = ?").bind(siteId).run();
          } else {
            await target.prepare("UPDATE sites SET admin_lock = 'another-call', admin_lock_until = ? WHERE id = ?").bind(Date.now() + 60_000, siteId).run();
            const slug = (await target.prepare("SELECT slug FROM sites WHERE id = ?").bind(siteId).first<{ slug: string }>())?.slug;
            await env.LIVE.put(livePointerKey(slug!), "", { customMetadata: { writer: "another-call" } });
          }
          return target.batch(statements);
        };
      }
      if (key === "prepare" && (fault === "prefix-delete-reread" || fault === "lease-lost-after-batch-reread" || fault === "lease-lost-before-batch-reread" || fault === "reread-only")) {
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
    // X-Test-Delay-Lease-Ms: <ms> runs the lease timing seam above for this request only.
    const delay = local ? Number(request.headers.get("X-Test-Delay-Lease-Ms") ?? "0") : 0;
    const baseEnv = raced !== null ? { ...env, DB: disablingBeforeTokenInsert(env.DB, raced) } : fault !== null ? withFault(env, fault, path) : env;
    const requestEnv = delay > 0 ? { ...baseEnv, DB: delayingLease(baseEnv.DB, delay) } : baseEnv;
    // X-Test-Now pins Date.now() while the Worker handles this request (./clock.ts).
    const handler = local && request.headers.has("X-Test-Unsafe-Live-Url") ? unsafeUrlWorker : worker;
    return withClock(request, local, async () => handler.fetch!(request, requestEnv, counting(ctx, path)));
  },
} satisfies ExportedHandler<TestEnv>;
