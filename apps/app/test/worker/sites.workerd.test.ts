import { DRAFT_JSON_MAX_BYTES, MAX_ISSUES } from "@asksite/app-common";
import { Brief, composeDocument, EMPTY_EDITS, LIMITS, photoRefIssues, toIssues, type AiDraft, type SiteVersionRow, type SiteView } from "@asksite/core";
import { Facts, SiteDocument } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { VALID_BRIEF, VALID_FACTS } from "../support/facts.ts";
import { json, readyOwner, ROOT, useAppHarness } from "../support/harness.ts";

const h = useAppHarness();

type ErrorJson = { error: { code: string; currentRev?: number; issues?: Array<{ path: unknown[]; code: string }> } };

describe("GET /api/sites/:siteId", () => {
  it("returns the §4.2 SiteView of a new draft, with its issues", async () => {
    const owner = await h.signIn();
    const view = await json<SiteView>(await h.call("GET", `/api/sites/${owner.siteId}`, { cookie: owner.cookie }));
    expect(view).toMatchObject({
      id: owner.siteId,
      slug: null,
      rev: 1,
      live: false,
      inReview: false,
      takenDown: false,
      liveUrl: null,
      facts: {},
      brief: {},
      edits: EMPTY_EDITS,
      ai: null,
      activeGeneration: null,
      pendingVersion: null,
      liveVersion: null,
      draftDiffersFromLive: false,
      uploads: [],
      limits: { generationsLeftToday: 5, generationsLeftTotal: 20 },
    });
    expect(view.issues.facts.length).toBeGreaterThan(0);
    expect(view.issues.facts.every((issue) => issue.path[0] === "facts")).toBe(true);
    expect(view.issues.brief.every((issue) => issue.path[0] === "brief")).toBe(true);
    expect(view.issues.document).toEqual([]);
  });

  it("answers 404 (never 403) for another owner's site or a malformed id", async () => {
    const a = await h.signIn();
    const b = await h.signIn();
    expect((await h.call("GET", `/api/sites/${b.siteId}`, { cookie: b.cookie })).status).toBe(200);
    for (const id of [b.siteId, "not-an-id"]) {
      const res = await h.call("GET", `/api/sites/${id}`, { cookie: a.cookie });
      expect(res.status).toBe(404);
    }
  });

  /**
   * A built site whose stored edits and AI draft no longer pass today's rules, as if a later Plan 1 rule refused
   * what was valid when it was stored: digits in the AI's headline, and the hero among the owner's hidden sections.
   */
  async function staleStoredDraft() {
    const owner = await h.signIn();
    await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: 1, facts: VALID_FACTS, brief: VALID_BRIEF } });
    const db = await h.db();
    // A finished first build, as the generator stores it (the input snapshot holds the parsed facts).
    const generationId = crypto.randomUUID();
    await db
      .prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at) VALUES (?, ?, ?, 'first', 'queued', ?, ?)")
      .bind(generationId, owner.siteId, owner.ownerId, JSON.stringify({ facts: Facts.parse(VALID_FACTS), brief: VALID_BRIEF }), Date.now())
      .run();
    expect((await h.call("POST", `/__test/generations/${generationId}/finish`, { body: { status: "succeeded" } })).status).toBe(200);
    const stored = await db.prepare("SELECT output_json FROM generations WHERE id = ?").bind(generationId).first<{ output_json: string }>();
    const draft = JSON.parse(stored?.output_json ?? "{}") as { copy: Record<string, unknown> };
    draft.copy["heroHeadline"] = "Call 555 today";
    const edits = { baseGenerationId: generationId, copy: { ctaText: "Call Joe" }, order: null, hidden: ["hero"], theme: null };
    await db.prepare("UPDATE generations SET output_json = ? WHERE id = ?").bind(JSON.stringify(draft), generationId).run();
    await db.prepare("UPDATE sites SET edits_json = ? WHERE id = ?").bind(JSON.stringify(edits), owner.siteId).run();
    return { ...owner, generationId, edits, rev: 2 };
  }

  it("still opens a draft whose stored parts no longer pass today's rules (decision 36)", async () => {
    const { generationId, edits, ...owner } = await staleStoredDraft();
    const res = await h.call("GET", `/api/sites/${owner.siteId}`, { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const view = await json<SiteView>(res);
    expect(view.ai?.generationId).toBe(generationId);
    // toMatchObject, not toEqual (A12 heads-up): a later OwnerEdits field must not break this test.
    expect(view.edits).toMatchObject({ ...edits, hidden: [] });
    expect([...new Set(view.issues.document.map((i) => i.path.join(".")))]).toEqual(["copy.heroHeadline"]);
  });

  it("shows the newest succeeded build as the AI draft: not an older one, nor a newer failed or queued one (§2.1)", async () => {
    const owner = await readyOwner(h, VALID_FACTS, VALID_BRIEF);
    const db = await h.db();
    const now = Date.now();
    /** A build made at `createdAt`, finished as the generator would (or left queued), by the one-active-job rule one at a time. */
    async function build(createdAt: number, outcome: "succeeded" | "failed" | "queued"): Promise<string> {
      const id = crypto.randomUUID();
      await db
        .prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at) VALUES (?, ?, ?, 'first', 'queued', ?, ?)")
        .bind(id, owner.siteId, owner.ownerId, JSON.stringify({ facts: Facts.parse(VALID_FACTS), brief: VALID_BRIEF }), createdAt)
        .run();
      if (outcome !== "queued") expect((await h.call("POST", `/__test/generations/${id}/finish`, { body: { status: outcome } })).status).toBe(200);
      return id;
    }
    await build(now - 3_000, "succeeded");
    const newest = await build(now - 2_000, "succeeded");
    await build(now - 1_000, "failed");
    const queued = await build(now, "queued");
    const view = await json<SiteView>(await h.call("GET", `/api/sites/${owner.siteId}`, { cookie: owner.cookie }));
    expect(view.ai?.generationId).toBe(newest);
    expect(view.activeGeneration?.id).toBe(queued);
  });

  it("notes each part it read leniently on the request's one log line, which names the route (P4-15 g)", async () => {
    const owner = await staleStoredDraft();
    const requests: Array<[method: string, path: string, body?: object]> = [
      ["GET", `/api/sites/${owner.siteId}`],
      ["PATCH", `/api/sites/${owner.siteId}/draft`, { rev: owner.rev, brief: VALID_BRIEF }],
      ["POST", `/api/sites/${owner.siteId}/publish-requests`, { rev: owner.rev + 1 }],
    ];
    const lines: Array<Record<string, unknown>> = [];
    for (const [method, path, body] of requests) {
      h.server.clearLogs();
      await h.call(method, path, { cookie: owner.cookie, ...(body === undefined ? {} : { body }) });
      lines.push(...h.logLines());
    }
    expect(lines.map((line) => [line["route"], line["status"], line["event"]])).toEqual([
      ["GET /api/sites/:siteId", 200, "stored_json_invalid"],
      ["PATCH /api/sites/:siteId/draft", 200, "stored_json_invalid"],
      ["POST /api/sites/:siteId/publish-requests", 422, "stored_json_invalid"],
    ]);
    for (const line of lines) expect(String(line["part"]).split(",").sort()).toEqual(["ai_draft", "edits"]);
  });

  /**
   * A version row of the site with a reviewer's note, as Plan 2 stores a reviewed one (the owner's view reads
   * only its summary fields). Any status can carry the note here, so only the owner's mapping decides what shows.
   */
  async function reviewedVersion(siteId: string, ownerId: string, number: number, status: SiteVersionRow["status"], note: string): Promise<string> {
    const id = crypto.randomUUID();
    await (await h.db())
      .prepare(
        `INSERT INTO site_versions (id, site_id, number, status, document_json, document_sha256, edits_json, html_key, html_sha256,
           stylesheet_sha256, requested_by, requested_at, reviewed_by, reviewed_at, review_note)
         VALUES (?, ?, ?, ?, '{}', 'doc-sha', '{}', 'html-key', 'html-sha', 'css-sha', ?, 1, 'admin@example.com', 2, ?)`,
      )
      .bind(id, siteId, number, status, ownerId, note)
      .run();
    return id;
  }

  it("never shows the owner the reviewer's note on an approved version (moderator decision (a))", async () => {
    const owner = await h.signIn();
    const live = await reviewedVersion(owner.siteId, owner.ownerId, 1, "approved", "Note for the record: license checked by phone");
    await (await h.db()).prepare("UPDATE sites SET live_version_id = ? WHERE id = ?").bind(live, owner.siteId).run();
    const res = await h.call("GET", `/api/sites/${owner.siteId}`, { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect((JSON.parse(text) as SiteView).liveVersion).toEqual({ id: live, number: 1, status: "approved", requestedAt: 1, reviewedAt: 2, reviewNote: null });
    expect(text).not.toContain("Note for the record");
  });

  it("shows the owner the reviewer's note on a rejected version: it is the reason they are given", async () => {
    const owner = await h.signIn();
    // No owner route lists a rejected version yet (the versions list is Task 10's), so the site's pending
    // pointer is aimed at one here, only to run the owner's version mapping on it.
    const rejected = await reviewedVersion(owner.siteId, owner.ownerId, 1, "rejected", "Please add your license number.");
    await (await h.db()).prepare("UPDATE sites SET pending_version_id = ? WHERE id = ?").bind(rejected, owner.siteId).run();
    const view = await json<SiteView>(await h.call("GET", `/api/sites/${owner.siteId}`, { cookie: owner.cookie }));
    expect(view.pendingVersion).toEqual({ id: rejected, number: 1, status: "rejected", requestedAt: 1, reviewedAt: 2, reviewNote: "Please add your license number." });
  });

  // P4-12: an allowlist, so a note on any status other than "rejected" (today's or a future one) stays hidden.
  it.each(["pending", "withdrawn", "superseded"] as const)("never shows the owner a reviewer's note on a %s version (P4-12)", async (status) => {
    const owner = await h.signIn();
    // As in the rejected test above: the pending pointer is aimed at the version only to run the owner's mapping on it.
    const version = await reviewedVersion(owner.siteId, owner.ownerId, 1, status, "Internal note: checked with the licensing board");
    await (await h.db()).prepare("UPDATE sites SET pending_version_id = ? WHERE id = ?").bind(version, owner.siteId).run();
    const res = await h.call("GET", `/api/sites/${owner.siteId}`, { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect((JSON.parse(text) as SiteView).pendingVersion).toEqual({ id: version, number: 1, status, requestedAt: 1, reviewedAt: 2, reviewNote: null });
    expect(text).not.toContain("Internal note");
  });
});

describe("PATCH /api/sites/:siteId/draft", () => {
  it("saves facts and brief, bumps rev and returns the remaining issues", async () => {
    const owner = await h.signIn();
    const res = await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: 1, facts: VALID_FACTS, brief: VALID_BRIEF } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rev: 2, issues: { facts: [], brief: [], photos: [], document: [] } });
    const view = await json<SiteView>(await h.call("GET", `/api/sites/${owner.siteId}`, { cookie: owner.cookie }));
    expect(view.facts).toEqual(VALID_FACTS);
    expect(view.rev).toBe(2);
  });

  // §4.4: a save replaces only the parts it sends. The questionnaire saves facts and brief, the editor edits alone.
  it("keeps the saved facts when a later save sends only the brief", async () => {
    const owner = await h.signIn();
    const save = (body: object) => h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body });
    expect((await save({ rev: 1, facts: VALID_FACTS, brief: VALID_BRIEF })).status).toBe(200);
    const brief = { ...VALID_BRIEF, tone: "professional" };
    expect((await save({ rev: 2, brief })).status).toBe(200);
    const view = await json<SiteView>(await h.call("GET", `/api/sites/${owner.siteId}`, { cookie: owner.cookie }));
    expect(view.rev).toBe(3);
    expect(view.facts).toEqual(VALID_FACTS);
    expect(view.brief).toEqual(brief);
  });

  it("keeps the saved edits and brief when a save sends only the facts, and the facts and brief when one sends only the edits", async () => {
    const owner = await h.signIn();
    const save = (body: object) => h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body });
    const read = async () => json<SiteView>(await h.call("GET", `/api/sites/${owner.siteId}`, { cookie: owner.cookie }));
    expect((await save({ rev: 1, brief: VALID_BRIEF, edits: { ...EMPTY_EDITS, copy: { ctaText: "Call Joe" } } })).status).toBe(200);

    expect((await save({ rev: 2, facts: VALID_FACTS })).status).toBe(200);
    const afterFacts = await read();
    expect(afterFacts.facts).toEqual(VALID_FACTS);
    expect(afterFacts.brief).toEqual(VALID_BRIEF);
    // Only the part this test set (A12 heads-up: never the whole edits object).
    expect(afterFacts.edits.copy).toEqual({ ctaText: "Call Joe" });

    expect((await save({ rev: 3, edits: { ...EMPTY_EDITS, copy: { ctaText: "Call us today" } } })).status).toBe(200);
    const afterEdits = await read();
    expect(afterEdits.rev).toBe(4);
    expect(afterEdits.facts).toEqual(VALID_FACTS);
    expect(afterEdits.brief).toEqual(VALID_BRIEF);
    expect(afterEdits.edits.copy).toEqual({ ctaText: "Call us today" });
  });

  it("keeps an incomplete draft and reports what is missing", async () => {
    const owner = await h.signIn();
    const res = await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: 1, facts: { businessName: "Joe's" } } });
    const body = await json<{ rev: number; issues: SiteView["issues"] }>(res);
    expect(body.rev).toBe(2);
    expect(body.issues.facts.map((issue) => issue.path.join("."))).toContain("facts.phone");
  });

  it("refuses a stale rev with 409 conflict and the current rev", async () => {
    const owner = await h.signIn();
    await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: 1, brief: VALID_BRIEF } });
    const res = await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: 1, brief: VALID_BRIEF } });
    expect(res.status).toBe(409);
    expect((await json<ErrorJson>(res)).error).toMatchObject({ code: "conflict", currentRev: 2 });
  });

  it("answers with its own save's rev and issues, even when another tab's save lands right after it (read in the same batch)", async () => {
    const owner = await h.signIn();
    // Right after this save commits, another tab's save empties the facts and moves the rev on.
    await h.call("POST", "/__test/save-after-site-write", { body: { siteId: owner.siteId, facts: {} } });
    const res = await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: 1, facts: VALID_FACTS, brief: VALID_BRIEF } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rev: 2, issues: { facts: [], brief: [], photos: [], document: [] } });
    // So this tab's next save, from the rev it was given, is refused instead of overwriting the other tab's.
    const next = await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: 2, brief: VALID_BRIEF } });
    expect(next.status).toBe(409);
    expect((await json<ErrorJson>(next)).error).toMatchObject({ code: "conflict", currentRev: 3 });
  });

  it("validates edits with the OwnerEdits schema and requires at least one part", async () => {
    const owner = await h.signIn();
    const bad = await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: 1, edits: { ...EMPTY_EDITS, hidden: ["hero"] } } });
    expect(bad.status).toBe(422);
    const empty = await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: 1 } });
    expect(empty.status).toBe(422);
  });

  it("refuses facts over LIMITS.factsJsonMaxBytes with the per-part 413, in a body the draft limit lets through (A8c)", async () => {
    const owner = await h.signIn();
    // One byte over the facts limit once JSON-encoded, in a body far under DRAFT_JSON_MAX_BYTES, so only
    // the per-part check can refuse it: deleting that check turns this red.
    const facts = { businessName: "x".repeat(LIMITS.factsJsonMaxBytes - '{"businessName":""}'.length + 1) };
    expect(JSON.stringify(facts).length).toBe(LIMITS.factsJsonMaxBytes + 1);
    const res = await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: 1, facts } });
    expect(res.status).toBe(413);
    expect((await json<ErrorJson>(res)).error).toEqual({ code: "payload_too_large", message: "That is more text than a website can hold. Please shorten it." });
  });

  it("refuses a body over DRAFT_JSON_MAX_BYTES with the body's 413, before any part is read (A8c)", async () => {
    const owner = await h.signIn();
    const facts = { businessName: "x".repeat(DRAFT_JSON_MAX_BYTES) };
    const res = await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: 1, facts } });
    expect(res.status).toBe(413);
    expect((await json<ErrorJson>(res)).error).toEqual({ code: "payload_too_large", message: "That is too large to save." });
  });

  it("refuses edits to a taken-down site with 423", async () => {
    const owner = await h.signIn();
    await (await h.db()).prepare("UPDATE sites SET taken_down_at = 1 WHERE id = ?").bind(owner.siteId).run();
    const res = await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: 1, brief: VALID_BRIEF } });
    expect(res.status).toBe(423);
  });

  it("cannot write another owner's site", async () => {
    const a = await h.signIn();
    const b = await h.signIn();
    const res = await h.call("PATCH", `/api/sites/${b.siteId}/draft`, { cookie: a.cookie, body: { rev: 1, brief: VALID_BRIEF } });
    expect(res.status).toBe(404);
    // The owner's own write of the same rev succeeds, so the stranger's request changed nothing.
    expect((await h.call("PATCH", `/api/sites/${b.siteId}/draft`, { cookie: b.cookie, body: { rev: 1, brief: VALID_BRIEF } })).status).toBe(200);
  });

  it(`lists at most the first MAX_ISSUES (${MAX_ISSUES}) issues in each list, in order (P4-3)`, async () => {
    const owner = await h.signIn();
    await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: 1, facts: VALID_FACTS, brief: VALID_BRIEF } });
    const db = await h.db();
    const generationId = crypto.randomUUID();
    await db
      .prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at) VALUES (?, ?, ?, 'first', 'queued', ?, ?)")
      .bind(generationId, owner.siteId, owner.ownerId, JSON.stringify({ facts: Facts.parse(VALID_FACTS), brief: VALID_BRIEF }), Date.now())
      .run();
    expect((await h.call("POST", `/__test/generations/${generationId}/finish`, { body: { status: "succeeded" } })).status).toBe(200);
    const stored = await db.prepare("SELECT output_json FROM generations WHERE id = ?").bind(generationId).first<{ output_json: string }>();
    const ai = { generationId, draft: JSON.parse(stored?.output_json ?? "{}") as AiDraft };

    // 60 entries in a list (the JSON shape guard allows 64) give every list more than MAX_ISSUES issues.
    const sixty = Array.from({ length: 60 }, (_, i) => i);
    const facts = {
      ...VALID_FACTS,
      serviceArea: { places: sixty },
      services: sixty.map((i) => ({ name: `Service ${i}` })),
      photos: sixty.map(() => ({ url: "https://example.com/photo.webp" })),
    };
    const brief = { ...VALID_BRIEF, comments: Object.fromEntries(sixty.map((i) => [`q${i}`, i])) };
    const all = {
      facts: toIssues(Facts.safeParse(facts).error!).map((issue) => ({ ...issue, path: ["facts", ...issue.path] })),
      brief: toIssues(Brief.safeParse(brief).error!).map((issue) => ({ ...issue, path: ["brief", ...issue.path] })),
      photos: photoRefIssues(facts, owner.siteId, ROOT, []),
      document: toIssues(SiteDocument.safeParse(composeDocument(facts, ai, EMPTY_EDITS)).error!).filter((issue) => issue.path[0] !== "facts"),
    };
    // Every list has more than MAX_ISSUES issues before any cap. Count zod's own issues: core's toIssues keeps
    // the first 50 itself (A9), so the lists above are already capped.
    const uncapped = {
      facts: Facts.safeParse(facts).error!.issues.length,
      brief: Brief.safeParse(brief).error!.issues.length,
      photos: all.photos.length,
      document: SiteDocument.safeParse(composeDocument(facts, ai, EMPTY_EDITS)).error!.issues.filter((issue) => issue.path[0] !== "facts").length,
    };
    for (const count of Object.values(uncapped)) expect(count).toBeGreaterThan(MAX_ISSUES);
    const first = {
      facts: all.facts.slice(0, MAX_ISSUES),
      brief: all.brief.slice(0, MAX_ISSUES),
      photos: all.photos.slice(0, MAX_ISSUES),
      document: all.document.slice(0, MAX_ISSUES),
    };

    const res = await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: 2, facts, brief } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rev: 3, issues: first });
    const view = await json<SiteView>(await h.call("GET", `/api/sites/${owner.siteId}`, { cookie: owner.cookie }));
    expect(view.issues).toEqual(first);
  });
});
