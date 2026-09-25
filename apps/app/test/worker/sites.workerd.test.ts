import { DRAFT_JSON_MAX_BYTES, MAX_ISSUES } from "@asksite/app-common";
import { Brief, composeDocument, EMPTY_EDITS, LIMITS, photoRefIssues, toIssues, type AiDraft, type SiteView } from "@asksite/core";
import { Facts, SiteDocument } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { VALID_BRIEF, VALID_FACTS } from "../support/facts.ts";
import { json, ROOT, useAppHarness } from "../support/harness.ts";

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

  it("still opens a draft whose stored parts no longer pass today's rules (decision 36)", async () => {
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
    // As if a later Plan 1 rule refused what was valid when it was stored: digits in the AI's
    // headline, and the hero among the owner's hidden sections.
    const stored = await db.prepare("SELECT output_json FROM generations WHERE id = ?").bind(generationId).first<{ output_json: string }>();
    const draft = JSON.parse(stored?.output_json ?? "{}") as { copy: Record<string, unknown> };
    draft.copy["heroHeadline"] = "Call 555 today";
    const edits = { baseGenerationId: generationId, copy: { ctaText: "Call Joe" }, order: null, hidden: ["hero"], theme: null };
    await db.prepare("UPDATE generations SET output_json = ? WHERE id = ?").bind(JSON.stringify(draft), generationId).run();
    await db.prepare("UPDATE sites SET edits_json = ? WHERE id = ?").bind(JSON.stringify(edits), owner.siteId).run();

    const res = await h.call("GET", `/api/sites/${owner.siteId}`, { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const view = await json<SiteView>(res);
    expect(view.ai?.generationId).toBe(generationId);
    // toMatchObject, not toEqual (A12 heads-up): a later OwnerEdits field must not break this test.
    expect(view.edits).toMatchObject({ ...edits, hidden: [] });
    expect([...new Set(view.issues.document.map((i) => i.path.join(".")))]).toEqual(["copy.heroHeadline"]);
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
    for (const list of Object.values(all)) expect(list.length).toBeGreaterThan(MAX_ISSUES);
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
