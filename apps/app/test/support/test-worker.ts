import { newId, newToken, sha256Hex, TTL } from "@asksite/core";
import { Hono } from "hono";
import { createWorker } from "../../src/worker/worker.ts";
import { fakeApprove, fakeCreateMailer, fakeGeneration, fakePublishing, finishGeneration } from "./fakes.ts";

// The app Worker wired to the fakes, plus /__test/* helpers that stand in for the admin and the
// generator in tests. Used by the Worker tests (test/wrangler.test.jsonc) and the browser tests
// (test/e2e/wrangler.e2e.jsonc). Never deployed: both configs are test files, and every helper
// answers 404 unless ENVIRONMENT is "development" on a *.localhost host name.
const worker = createWorker({ generation: fakeGeneration, publishing: fakePublishing, createMailer: fakeCreateMailer });

const helpers = new Hono<{ Bindings: Env }>();

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

/** What the admin's approval does to D1. */
helpers.post("/__test/versions/:versionId/approve", async (c) => c.json(await fakeApprove(c.env, c.req.param("versionId"), Date.now())));

export default {
  fetch(request, env, ctx) {
    return new URL(request.url).pathname.startsWith("/__test/") ? helpers.fetch(request, env, ctx) : worker.fetch!(request, env, ctx);
  },
  scheduled(controller, env, ctx) {
    return worker.scheduled!(controller, env, ctx);
  },
} satisfies ExportedHandler<Env>;
