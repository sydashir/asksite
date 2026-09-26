import { MAX_ISSUES } from "@asksite/app-common";
import { Brief, photoRefIssues, toIssues, type GenerationView, type SiteView } from "@asksite/core";
import { Facts } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { VALID_BRIEF, VALID_FACTS } from "../support/facts.ts";
import { builtOwner, json, readyOwner, ROOT, useAppHarness } from "../support/harness.ts";

const h = useAppHarness();

type ErrorJson = { error: { code: string; message: string; issues?: Array<{ path: unknown[] }>; retryAfter?: number } };

describe("POST /api/sites/:siteId/generations", () => {
  it("refuses an unfinished questionnaire with 422 not_ready and the issues", async () => {
    const owner = await h.signIn();
    const res = await h.call("POST", `/api/sites/${owner.siteId}/generations`, { cookie: owner.cookie, body: {} });
    expect(res.status).toBe(422);
    const body = await json<ErrorJson>(res);
    expect(body.error.code).toBe("not_ready");
    const paths = body.error.issues?.map((i) => i.path.join(".")) ?? [];
    expect(paths).toContain("facts.businessName");
    expect(paths).toContain("brief.tone");
  });

  it(`lists at most the first MAX_ISSUES (${MAX_ISSUES}) issues of an unready draft, in order (P4-3)`, async () => {
    const owner = await h.signIn();
    // Sixty photos no upload backs (the JSON shape guard allows 64 items): one facts issue (more than 12
    // photos), one brief issue (the tone), then one photo_ref issue per photo, so the cut falls in the photos.
    const facts = {
      ...VALID_FACTS,
      photos: Array.from({ length: 60 }, (_, i) => ({ url: `https://example.com/photo-${i}.webp`, alt: "A finished job", width: 800, height: 600 })),
    };
    const brief = { ...VALID_BRIEF, tone: "loud" };
    const saved = await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: 1, facts, brief } });
    expect(saved.status).toBe(200);
    const all = [
      ...toIssues(Facts.safeParse(facts).error!).map((issue) => ({ ...issue, path: ["facts", ...issue.path] })),
      ...toIssues(Brief.safeParse(brief).error!).map((issue) => ({ ...issue, path: ["brief", ...issue.path] })),
      ...photoRefIssues(facts, owner.siteId, ROOT, []),
    ];
    expect(all.length).toBeGreaterThan(MAX_ISSUES);

    const res = await h.call("POST", `/api/sites/${owner.siteId}/generations`, { cookie: owner.cookie, body: {} });
    expect(res.status).toBe(422);
    const body = await json<ErrorJson>(res);
    expect(body.error.code).toBe("not_ready");
    expect(body.error.issues).toEqual(all.slice(0, MAX_ISSUES));
  });

  it("queues the first build (202) and the progress poll sees it finish", async () => {
    const owner = await readyOwner(h, VALID_FACTS, VALID_BRIEF);
    const res = await h.call("POST", `/api/sites/${owner.siteId}/generations`, { cookie: owner.cookie, body: {} });
    expect(res.status).toBe(202);
    const { generation } = await json<{ generation: GenerationView }>(res);
    expect(generation).toMatchObject({ kind: "first", status: "queued", usedFallback: false, errorCode: null });

    const poll = () => h.call("GET", `/api/sites/${owner.siteId}/generations/${generation.id}`, { cookie: owner.cookie });
    expect((await json<GenerationView>(await poll())).status).toBe("queued");
    await h.call("POST", `/__test/generations/${generation.id}/finish`, { body: { status: "succeeded" } });
    expect((await json<GenerationView>(await poll())).status).toBe("succeeded");

    const view = await json<SiteView>(await h.call("GET", `/api/sites/${owner.siteId}`, { cookie: owner.cookie }));
    expect(view.ai?.generationId).toBe(generation.id);
    expect(view.activeGeneration).toBeNull();
    expect(view.issues.document).toEqual([]);
    // A first build uses one of today's builds but none of the owner's lifetime rewrites (decision 40).
    expect(view.limits).toEqual({ generationsLeftToday: 4, generationsLeftTotal: 20 });
  });

  it("allows one job at a time (409 generation_in_progress)", async () => {
    const owner = await readyOwner(h, VALID_FACTS, VALID_BRIEF);
    await h.call("POST", `/api/sites/${owner.siteId}/generations`, { cookie: owner.cookie, body: {} });
    const again = await h.call("POST", `/api/sites/${owner.siteId}/generations`, { cookie: owner.cookie, body: {} });
    expect(again.status).toBe(409);
    expect((await json<ErrorJson>(again)).error.code).toBe("generation_in_progress");
  });

  it("stops at the daily cap with 429 and a retryAfter until midnight UTC", async () => {
    const owner = await builtOwner(h, VALID_FACTS, VALID_BRIEF);
    const db = await h.db();
    for (let i = 0; i < 4; i += 1) {
      await db.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at) VALUES (?, ?, ?, 'regenerate', 'failed', '{}', ?)")
        .bind(crypto.randomUUID(), owner.siteId, owner.ownerId, Date.now()).run();
    }
    const res = await h.call("POST", `/api/sites/${owner.siteId}/generations`, { cookie: owner.cookie, body: {} });
    expect(res.status).toBe(429);
    const body = await json<ErrorJson>(res);
    expect(body.error.code).toBe("generation_cap_reached");
    expect(body.error.message).toBe("You have used all the rewrites for today. Try again tomorrow.");
    expect(body.error.retryAfter).toBeGreaterThan(0);
    expect(res.headers.get("Retry-After")).toBe(String(body.error.retryAfter));
  });

  it("at the owner's lifetime cap, refuses a regeneration and says so instead of 'tomorrow'; a first build still queues (decision 40)", async () => {
    const owner = await builtOwner(h, VALID_FACTS, VALID_BRIEF);
    const db = await h.db();
    const longAgo = Date.now() - 3 * 86_400_000;
    for (let i = 0; i < 20; i += 1) {
      await db.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at) VALUES (?, ?, ?, 'regenerate', 'failed', '{}', ?)")
        .bind(crypto.randomUUID(), owner.siteId, owner.ownerId, longAgo).run();
    }
    const res = await h.call("POST", `/api/sites/${owner.siteId}/generations`, { cookie: owner.cookie, body: {} });
    expect(res.status).toBe(429);
    const body = await json<ErrorJson>(res);
    expect(body.error).toMatchObject({ code: "generation_cap_reached", retryAfter: 86_400 });
    expect(body.error.message).toBe("You have used all the rewrites your account includes. Contact us if you need more.");

    // The same owner's second site (a second invite): its first build is not refused by the lifetime cap.
    const second = await h.signIn(owner.email);
    expect(second.ownerId).toBe(owner.ownerId);
    const saved = await h.call("PATCH", `/api/sites/${second.siteId}/draft`, { cookie: second.cookie, body: { rev: 1, facts: VALID_FACTS, brief: VALID_BRIEF } });
    expect(saved.status).toBe(200);
    const first = await h.call("POST", `/api/sites/${second.siteId}/generations`, { cookie: second.cookie, body: {} });
    expect(first.status).toBe(202);
    expect((await json<{ generation: GenerationView }>(first)).generation.kind).toBe("first");
  });

  it("a first build refused by the daily cap is told 'tomorrow', even at 0 left in total (decision 40)", async () => {
    const owner = await readyOwner(h, VALID_FACTS, VALID_BRIEF);
    const db = await h.db();
    const longAgo = Date.now() - 3 * 86_400_000;
    for (let i = 0; i < 20; i += 1) {
      await db.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at) VALUES (?, ?, ?, 'regenerate', 'failed', '{}', ?)")
        .bind(crypto.randomUUID(), owner.siteId, owner.ownerId, longAgo).run();
    }
    // Five failed first builds today fill the site's daily cap; with no succeeded build the next request is still a first build.
    for (let i = 0; i < 5; i += 1) {
      await db.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at) VALUES (?, ?, ?, 'first', 'failed', '{}', ?)")
        .bind(crypto.randomUUID(), owner.siteId, owner.ownerId, Date.now()).run();
    }
    const view = await json<SiteView>(await h.call("GET", `/api/sites/${owner.siteId}`, { cookie: owner.cookie }));
    expect(view.limits).toEqual({ generationsLeftToday: 0, generationsLeftTotal: 0 });

    const res = await h.call("POST", `/api/sites/${owner.siteId}/generations`, { cookie: owner.cookie, body: {} });
    expect(res.status).toBe(429);
    const body = await json<ErrorJson>(res);
    expect(body.error.code).toBe("generation_cap_reached");
    expect(body.error.message).toBe("You have used all the rewrites for today. Try again tomorrow.");
    expect(body.error.retryAfter).toBeGreaterThan(0);
    expect(res.headers.get("Retry-After")).toBe(String(body.error.retryAfter));
  });

  it("returns 404 for another site's generation", async () => {
    const a = await builtOwner(h, VALID_FACTS, VALID_BRIEF);
    const b = await h.signIn();
    expect((await h.call("GET", `/api/sites/${b.siteId}/generations/${a.generationId}`, { cookie: b.cookie })).status).toBe(404);
  });

  it("refuses a taken-down site with 423", async () => {
    const owner = await readyOwner(h, VALID_FACTS, VALID_BRIEF);
    await (await h.db()).prepare("UPDATE sites SET taken_down_at = 1 WHERE id = ?").bind(owner.siteId).run();
    expect((await h.call("POST", `/api/sites/${owner.siteId}/generations`, { cookie: owner.cookie, body: {} })).status).toBe(423);
  });
});
