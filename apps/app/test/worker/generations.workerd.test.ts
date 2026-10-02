import { MAX_ISSUES, secondsUntilUtcMidnight } from "@asksite/app-common";
import { Brief, composeDocument, EMPTY_EDITS, mediaUrl, photoRefIssues, toIssues, type GenerationView, type SiteView, type UploadView } from "@asksite/core";
import { Facts, SiteDocument } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { VALID_BRIEF, VALID_FACTS } from "../support/facts.ts";
import { APP_ORIGIN, awayFromUtcHourEnd, builtOwner, json, readyOwner, ROOT, useAppHarness } from "../support/harness.ts";
import { png, upload } from "../support/images.ts";

const h = useAppHarness();

type ErrorJson = { error: { code: string; message: string; issues?: Array<{ path: unknown[]; code: string }>; retryAfter?: number } };

/** How many generations the site has, of any status. */
async function buildCount(siteId: string): Promise<number | undefined> {
  return (await (await h.db()).prepare("SELECT COUNT(*) AS n FROM generations WHERE site_id = ?").bind(siteId).first<{ n: number }>())?.n;
}

describe("POST /api/sites/:siteId/generations", () => {
  it("refuses a body not declared as JSON with 403, queuing nothing (the content-type check)", async () => {
    const owner = await readyOwner(h, VALID_FACTS, VALID_BRIEF);
    const res = await h.server.fetch(`${APP_ORIGIN}/api/sites/${owner.siteId}/generations`, {
      method: "POST",
      headers: { Origin: APP_ORIGIN, Cookie: owner.cookie, "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect((await json<ErrorJson>(res)).error).toEqual({ code: "forbidden", message: "Expected a JSON request" });
    expect(await buildCount(owner.siteId)).toBe(0);
  });

  it.each([
    ["generation_disabled", 503, "Writing new wording is switched off right now. Your current wording is safe."],
    ["budget_exhausted", 503, "We have reached today's limit for writing new wording. Try again tomorrow."],
    ["internal", 500, "Something went wrong. Please try again."],
  ] as const)("answers the generator's %s refusal as %i with its message, queuing nothing", async (code, status, message) => {
    const owner = await readyOwner(h, VALID_FACTS, VALID_BRIEF);
    await h.call("POST", "/__test/generation-refuses", { body: { code } });
    const res = await h.call("POST", `/api/sites/${owner.siteId}/generations`, { cookie: owner.cookie, body: {} });
    expect(res.status).toBe(status);
    expect((await json<ErrorJson>(res)).error).toEqual({ code, message });
    expect(await buildCount(owner.siteId)).toBe(0);
  });

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

  it("builds only when every photo is one of this site's own uploads (§3.1 step 4)", async () => {
    const owner = await h.signIn();
    const db = await h.db();
    const builds = async () => (await db.prepare("SELECT COUNT(*) AS n FROM generations WHERE site_id = ?").bind(owner.siteId).first<{ n: number }>())?.n;
    const draft = (photo: object) => ({ facts: { ...VALID_FACTS, photos: [photo] }, brief: VALID_BRIEF });

    // Valid answers whose one photo no upload of this site backs: only the photo reference is wrong.
    const unbacked = { url: mediaUrl(ROOT, owner.siteId, crypto.randomUUID()), alt: "New water heater in a garage", width: 400, height: 300 };
    expect((await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: 1, ...draft(unbacked) } })).status).toBe(200);
    const refused = await h.call("POST", `/api/sites/${owner.siteId}/generations`, { cookie: owner.cookie, body: {} });
    expect(refused.status).toBe(422);
    const body = await json<ErrorJson>(refused);
    expect(body.error.code).toBe("not_ready");
    expect(body.error.issues?.map((i) => [i.path.join("."), i.code])).toEqual([["facts.photos.0.url", "photo_ref"]]);
    expect(await builds()).toBe(0);

    // The same draft with a real upload's address and size builds.
    const uploaded = await h.call("POST", `/api/sites/${owner.siteId}/uploads`, { cookie: owner.cookie, body: upload(await png(400, 300), "x.png", "image/png") });
    expect(uploaded.status).toBe(201);
    const photo = await json<UploadView>(uploaded);
    const backed = { ...unbacked, url: photo.url, width: photo.width, height: photo.height };
    expect((await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: 2, ...draft(backed) } })).status).toBe(200);
    expect((await h.call("POST", `/api/sites/${owner.siteId}/generations`, { cookie: owner.cookie, body: {} })).status).toBe(202);
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
    expect((await json<ErrorJson>(again)).error).toEqual({ code: "generation_in_progress", message: "Your website is already being written. It will be ready soon." });
  });

  it("stops at the daily cap with 429 and a retryAfter until midnight UTC", async () => {
    const owner = await builtOwner(h, VALID_FACTS, VALID_BRIEF);
    const db = await h.db();
    for (let i = 0; i < 4; i += 1) {
      await db.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at) VALUES (?, ?, ?, 'regenerate', 'failed', '{}', ?)")
        .bind(crypto.randomUUID(), owner.siteId, owner.ownerId, Date.now()).run();
    }
    await awayFromUtcHourEnd();
    const before = secondsUntilUtcMidnight(Date.now());
    const res = await h.call("POST", `/api/sites/${owner.siteId}/generations`, { cookie: owner.cookie, body: {} });
    const after = secondsUntilUtcMidnight(Date.now());
    expect(res.status).toBe(429);
    const body = await json<ErrorJson>(res);
    expect(body.error.code).toBe("generation_cap_reached");
    expect(body.error.message).toBe("You have used all the rewrites for today. Try again tomorrow.");
    // The seconds to the next 00:00 UTC, as of the request.
    expect(body.error.retryAfter).toBeGreaterThanOrEqual(after);
    expect(body.error.retryAfter).toBeLessThanOrEqual(before);
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

  it("cannot request or read a build of another owner's site (404, nothing queued)", async () => {
    const a = await readyOwner(h, VALID_FACTS, VALID_BRIEF);
    const b = await h.signIn();
    const db = await h.db();
    const builds = async () => (await db.prepare("SELECT COUNT(*) AS n FROM generations WHERE site_id = ?").bind(a.siteId).first<{ n: number }>())?.n;

    // A's site is ready, so only the owner check stands between B and a build on it.
    const post = await h.call("POST", `/api/sites/${a.siteId}/generations`, { cookie: b.cookie, body: {} });
    expect(post.status).toBe(404);
    expect((await json<ErrorJson>(post)).error.code).toBe("not_found");
    expect(await builds()).toBe(0);

    // A's own request of the same site queues, so B's was refused for being B's.
    const own = await h.call("POST", `/api/sites/${a.siteId}/generations`, { cookie: a.cookie, body: {} });
    expect(own.status).toBe(202);
    const { generation } = await json<{ generation: GenerationView }>(own);

    // B's read of A's build through A's own site path is refused too; A's read of it works.
    const read = await h.call("GET", `/api/sites/${a.siteId}/generations/${generation.id}`, { cookie: b.cookie });
    expect(read.status).toBe(404);
    expect((await json<ErrorJson>(read)).error.code).toBe("not_found");
    expect((await h.call("GET", `/api/sites/${a.siteId}/generations/${generation.id}`, { cookie: a.cookie })).status).toBe(200);
  });

  it("refuses a taken-down site with 423", async () => {
    const owner = await readyOwner(h, VALID_FACTS, VALID_BRIEF);
    await (await h.db()).prepare("UPDATE sites SET taken_down_at = 1 WHERE id = ?").bind(owner.siteId).run();
    expect((await h.call("POST", `/api/sites/${owner.siteId}/generations`, { cookie: owner.cookie, body: {} })).status).toBe(423);
  });
});

// A12 §3: before a rebuild is asked for, the look the page shows now is written into the owner's edits, so the new
// draft cannot change it. A roofing site's draft starts on the "refined" design, not the default one.
describe("POST /api/sites/:siteId/generations pins the current look (A12 §3)", () => {
  const ROOFING = { ...VALID_FACTS, trade: "roofing" };

  /** The site's stored edits (as text), rev and last change time. */
  async function siteRow(siteId: string) {
    return (await h.db()).prepare("SELECT edits_json, rev, updated_at FROM sites WHERE id = ?").bind(siteId).first<{ edits_json: string; rev: number; updated_at: number }>();
  }

  const rebuild = (owner: { siteId: string; cookie: string }) => h.call("POST", `/api/sites/${owner.siteId}/generations`, { cookie: owner.cookie, body: {} });
  const view = async (owner: { siteId: string; cookie: string }) => json<SiteView>(await h.call("GET", `/api/sites/${owner.siteId}`, { cookie: owner.cookie }));

  it("sets a null theme to the AI draft's, changes nothing else in the edits and keeps the rev", async () => {
    const owner = await builtOwner(h, ROOFING, VALID_BRIEF);
    // Wording is bound to the AI draft it was written on (the edit-binding guard), so this save names the current one.
    const edits = { ...EMPTY_EDITS, baseGenerationId: owner.generationId, copy: { ctaText: "Call Joe" }, hidden: ["faq"] };
    expect((await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: owner.rev, edits } })).status).toBe(200);
    const before = await siteRow(owner.siteId);
    // The first build pinned nothing: there was no AI draft yet.
    expect(JSON.parse(before?.edits_json ?? "null")).toMatchObject({ theme: null });
    const aiTheme = (await view(owner)).ai?.draft.theme;
    expect(aiTheme).toEqual({ palette: "navy-orange", font: "clean", design: "refined" });

    expect((await rebuild(owner)).status).toBe(202);
    const after = await siteRow(owner.siteId);
    expect(JSON.parse(after?.edits_json ?? "null")).toEqual({ ...JSON.parse(before?.edits_json ?? "null"), theme: aiTheme });
    expect(after?.rev).toBe(before?.rev);
  });

  it("leaves a theme the owner chose alone", async () => {
    const owner = await builtOwner(h, ROOFING, VALID_BRIEF);
    const theme = { palette: "green-amber", font: "sturdy", design: "modern" };
    expect((await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: owner.rev, edits: { ...EMPTY_EDITS, theme } } })).status).toBe(200);
    const before = await siteRow(owner.siteId);
    expect((await rebuild(owner)).status).toBe(202);
    expect(await siteRow(owner.siteId)).toEqual(before);
    expect(JSON.parse(before?.edits_json ?? "null")).toMatchObject({ theme });
  });

  it("skips stored edits that are not valid JSON: they stay as they are and the rebuild still queues", async () => {
    const owner = await builtOwner(h, ROOFING, VALID_BRIEF);
    await (await h.db()).prepare("UPDATE sites SET edits_json = ? WHERE id = ?").bind('{"theme":null', owner.siteId).run();
    const before = await siteRow(owner.siteId);
    expect((await rebuild(owner)).status).toBe(202);
    expect(await siteRow(owner.siteId)).toEqual(before);
  });

  // P4-21 item 6: sqlite.org/lang_expr.html documents CASE as lazy, but not the order AND evaluates its operands in.
  it("reads the stored theme only inside the documented-lazy CASE WHEN json_valid(edits_json) THEN ... ELSE 0 END", async () => {
    const owner = await builtOwner(h, ROOFING, VALID_BRIEF);
    const path = `/api/sites/${owner.siteId}/generations`;
    await h.recordSql(path);
    expect((await rebuild(owner)).status).toBe(202);
    const pins = (await h.recordedSql(path)).filter((sql) => /^\s*UPDATE sites\b/.test(sql)).map((sql) => sql.replace(/\s+/g, " "));
    expect(pins).toHaveLength(1);
    expect(pins[0]?.match(/json_valid\(/g)).toHaveLength(1);
    expect(pins[0]).toContain("CASE WHEN json_valid(edits_json) THEN json_extract(edits_json, '$.theme') IS NULL ELSE 0 END");
  });

  // P4-21 item 7, A12 §3's purpose: a rebuild that succeeds with another design never changes the look the owner saw.
  it("keeps the pinned look after a rebuild that succeeds with a different design, when the tab that asked for it saves edits whose theme is null", async () => {
    const owner = await builtOwner(h, ROOFING, VALID_BRIEF);
    const before = await view(owner);
    expect(before.edits.theme).toBeNull();
    expect(before.ai?.draft.theme.design).toBe("refined");
    // The owner's trade changes, so the next draft starts on another design (cleaning's "modern").
    const traded = await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: owner.rev, facts: { ...ROOFING, trade: "cleaning" } } });
    expect(traded.status).toBe(200);
    const rev = (await json<{ rev: number }>(traded)).rev;
    const asked = await rebuild(owner);
    expect(asked.status).toBe(202);
    const { generation } = await json<{ generation: GenerationView }>(asked);
    expect((await h.call("POST", `/__test/generations/${generation.id}/finish`, { body: { status: "succeeded" } })).status).toBe(200);
    const rebuilt = await view(owner);
    expect(rebuilt.ai?.generationId).toBe(generation.id);
    expect(rebuilt.ai?.draft.theme.design).toBe("modern");
    // The tab that asked for the rebuild still holds its edits with no theme, and autosaves them (a hidden section: wording
    // built on the older draft would be refused by the edit-binding guard, hidden sections carry over).
    const saved = await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev, edits: { ...before.edits, hidden: ["faq"] } } });
    expect(saved.status).toBe(200);
    const after = await view(owner);
    expect(after.edits.theme).toEqual(before.ai?.draft.theme);
    expect(after.edits.hidden).toEqual(["faq"]);
    // The page shows the look it showed before the rebuild, not the new draft's.
    const page = (site: SiteView) => (site.ai === null ? null : SiteDocument.parse(composeDocument(site.facts, site.ai, site.edits)));
    expect(page(after)?.theme).toEqual(page(before)?.theme);
  });

  // P4-21 item 8: POST /generations reads the stored AI draft (to pin its theme) leniently, like every other route.
  it("notes a stored AI draft that is not valid JSON on the request's one log line, which names the route (P4-15 g)", async () => {
    const owner = await builtOwner(h, ROOFING, VALID_BRIEF);
    await (await h.db()).prepare("UPDATE generations SET output_json = ? WHERE id = ?").bind('{"copy":', owner.generationId).run();
    h.server.clearLogs();
    expect((await rebuild(owner)).status).toBe(202);
    const lines = h.logLines().filter((line) => line["route"] === "POST /api/sites/:siteId/generations");
    expect(lines).toEqual([expect.objectContaining({ status: 202, event: "stored_json_invalid", part: "ai_draft" })]);
  });

  it("a rebuild refused after the pin leaves the page as it was: the pinned theme is the one it showed", async () => {
    const owner = await builtOwner(h, ROOFING, VALID_BRIEF);
    const before = await view(owner);
    expect(before.edits.theme).toBeNull();
    await h.call("POST", "/__test/generation-refuses", { body: { code: "generation_disabled" } });
    expect((await rebuild(owner)).status).toBe(503);

    const after = await view(owner);
    // Pinned before the generator was asked, which refused.
    expect(after.edits.theme).toEqual(before.ai?.draft.theme);
    const page = (site: SiteView) => (site.ai === null ? null : SiteDocument.parse(composeDocument(site.facts, site.ai, site.edits)));
    expect(page(before)).not.toBeNull();
    expect(page(after)).toEqual(page(before));
  });
});
