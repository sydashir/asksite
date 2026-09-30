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

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith("/__test/")) return helpers.fetch(request, env, ctx);
    // X-Test-Now pins Date.now() while the Worker handles this request (./clock.ts).
    return withClock(request, isLocalTest(request, env), async () => worker.fetch!(request, env, ctx));
  },
} satisfies ExportedHandler<TestEnv>;
