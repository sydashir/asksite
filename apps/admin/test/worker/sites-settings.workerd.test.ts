import { beforeEach, describe, expect, it } from "vitest";
import { jobCostText, spentTodayText } from "../../src/client/lib/format.ts";
import type { SettingsView } from "../../src/settings-view.ts";
import { json, useAdminHarness } from "../support/harness.ts";

const h = useAdminHarness();

describe("sites and owners", () => {
  it("filters sites and shows a site's history", async () => {
    const site = await h.pendingSite();
    const inReview = await json<{ sites: Array<{ id: string }> }>(await h.call("GET", "/api/admin/sites?filter=in_review"));
    expect(inReview.sites.map((s) => s.id)).toContain(site.siteId);
    const live = await json<{ sites: Array<{ id: string }> }>(await h.call("GET", "/api/admin/sites?filter=live"));
    expect(live.sites.map((s) => s.id)).not.toContain(site.siteId);
    expect((await h.call("GET", "/api/admin/sites?filter=nope")).status).toBe(400);
    const detail = await json<{ versions: unknown[]; generations: Array<{ costMicrousd: number }>; leadCount: number }>(await h.call("GET", `/api/admin/sites/${site.siteId}`));
    expect(detail.versions).toHaveLength(1);
    expect(detail.generations[0]).toMatchObject({ costMicrousd: 0 });
    expect(detail.leadCount).toBe(0);
  });

  it("takes a live site down (with a message to the owner) and restores it", async () => {
    const site = await h.pendingSite();
    await h.call("POST", `/api/admin/versions/${site.versionId}/approve`, { body: { htmlSha256: site.htmlSha256 } });
    const down = await h.call("POST", `/api/admin/sites/${site.siteId}/takedown`, { body: { reason: "Phishing report", ownerMessage: "We received a report about your page." } });
    expect(down.status).toBe(200);
    expect(await h.liveKeys(site.slug)).toEqual([]); // no pointer and nothing under <slug>/
    const notices = (await h.outbox(site.email)).filter((m) => m.tag === "site_notice");
    expect(notices[0]?.text).toContain("We received a report about your page.");
    const restored = await h.call("POST", `/api/admin/sites/${site.siteId}/restore`, { body: await h.restoreBody(site.siteId) });
    expect(await restored.json()).toEqual({ liveUrl: `https://${site.slug}.localhost:8789/`, missingPhotos: 0, healed: false });
    const audit = await json<{ audit: Array<{ action: string; actor: string }> }>(await h.call("GET", `/api/admin/sites/${site.siteId}`));
    expect(audit.audit.map((a) => a.action)).toEqual(expect.arrayContaining(["site.taken_down", "site.restored", "version.approved"]));
    expect(audit.audit.every((a) => a.actor.startsWith("admin:") || a.actor.startsWith("owner:"))).toBe(true);
  });

  it("tells the owner about a takedown even without a message, and where to ask (decision 34)", async () => {
    const site = await h.pendingSite();
    expect((await h.call("POST", `/api/admin/sites/${site.siteId}/takedown`, { body: { reason: "Spam report" } })).status).toBe(200);
    const notices = (await h.outbox(site.email)).filter((m) => m.tag === "site_notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain("If you have questions, reply to this email or write to help@example.com.");
  });

  it("restoring a site that was never live is 409 conflict", async () => {
    const site = await h.pendingSite();
    expect((await h.call("POST", `/api/admin/sites/${site.siteId}/restore`, { body: { expectedTakenDownAt: 1 } })).status).toBe(409);
  });

  it("turns search engines off and on", async () => {
    const site = await h.pendingSite();
    expect((await h.call("PUT", `/api/admin/sites/${site.siteId}/indexable`, { body: { indexable: false } })).status).toBe(200);
    const row = await (await h.db()).prepare("SELECT indexable FROM sites WHERE id = ?").bind(site.siteId).first<{ indexable: number }>();
    expect(row?.indexable).toBe(0);
    expect((await h.call("PUT", "/api/admin/sites/00000000-0000-4000-8000-000000000000/indexable", { body: { indexable: true } })).status).toBe(404);
  });

  it("disabling an owner ends their sessions; enabling lets them back", async () => {
    const site = await h.pendingSite();
    const db = await h.db();
    await db.prepare("INSERT INTO sessions (id_hash, owner_id, created_at, expires_at, last_seen_at) VALUES ('s1', ?, 1, 9999999999999, 1)").bind(site.ownerId).run();
    expect((await h.call("POST", `/api/admin/owners/${site.ownerId}/disable`, { body: { reason: "Abuse" } })).status).toBe(200);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE owner_id = ?").bind(site.ownerId).first<{ n: number }>())?.n).toBe(0);
    expect((await db.prepare("SELECT disabled_at FROM owners WHERE id = ?").bind(site.ownerId).first<{ disabled_at: number | null }>())?.disabled_at).not.toBeNull();
    expect((await h.call("POST", `/api/admin/owners/${site.ownerId}/enable`, { body: {} })).status).toBe(200);
    expect((await db.prepare("SELECT disabled_at FROM owners WHERE id = ?").bind(site.ownerId).first<{ disabled_at: number | null }>())?.disabled_at).toBeNull();
    const audit = await db
      .prepare("SELECT action, actor FROM audit_log WHERE action IN ('owner.disabled', 'owner.enabled') AND detail_json LIKE ? ORDER BY id")
      .bind(`%"ownerId":"${site.ownerId}"%`)
      .all<{ action: string; actor: string }>();
    expect(audit.results).toEqual([
      { action: "owner.disabled", actor: "admin:admin@example.com" },
      { action: "owner.enabled", actor: "admin:admin@example.com" },
    ]);
    const unknown = "00000000-0000-4000-8000-000000000000";
    expect((await h.call("POST", `/api/admin/owners/${unknown}/disable`, { body: { reason: "x" } })).status).toBe(404);
    expect((await h.call("POST", `/api/admin/owners/${unknown}/enable`, { body: {} })).status).toBe(404);
    // A refused change leaves no audit row.
    expect((await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE detail_json LIKE ?").bind(`%${unknown}%`).first<{ n: number }>())?.n).toBe(0);
  });
});

describe("settings", () => {
  it("shows the kill switch and the daily limit, and updates both with an audit row", async () => {
    const before = await json<SettingsView>(await h.call("GET", "/api/admin/settings"));
    expect(before).toEqual({ generationEnabled: true, envGenerationEnabled: true, dailyModelLimit: 30, modelCallsToday: 0, spentTodayMicrousd: 0, unknownCostJobsToday: 0, worstCaseDailyMicrousd: 30 * 336_000 });
    const after = await json<SettingsView>(await h.call("PUT", "/api/admin/settings", { body: { generationEnabled: false, dailyModelLimit: 5 } }));
    expect(after).toMatchObject({ generationEnabled: false, dailyModelLimit: 5, worstCaseDailyMicrousd: 5 * 336_000 });
    expect((await h.call("PUT", "/api/admin/settings", { body: { dailyModelLimit: 5000 } })).status).toBe(422);
    const audit = await (await h.db()).prepare("SELECT actor FROM audit_log WHERE action = 'settings.updated'").bind().all<{ actor: string }>();
    expect(audit.results.map((a) => a.actor)).toEqual(["admin:admin@example.com"]);
  });
});

describe("settings when the configured model has no recorded price", () => {
  const unpriced = useAdminHarness({ MODEL_ID: "unpriced-model" });

  it("shows the worst case as unknown and still saves (Plan 3 answers null, never a made-up figure)", async () => {
    const before = await json<SettingsView>(await unpriced.call("GET", "/api/admin/settings"));
    expect(before.worstCaseDailyMicrousd).toBeNull();
    const saved = await unpriced.call("PUT", "/api/admin/settings", { body: { dailyModelLimit: 4 } });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ dailyModelLimit: 4, worstCaseDailyMicrousd: null });
  });
});

describe("settings usage figures (the admin's spend against the cap)", () => {
  const usage = useAdminHarness();

  it("counts only today's model-slot calls, and sums today's cost of every generation", async () => {
    const site = await usage.pendingSite();
    const db = await usage.db();
    const today = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const insert = (id: string, slot: number, startedAt: number, cost: number) =>
      db
        .prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, model_slot, cost_microusd, created_at, started_at) VALUES (?, ?, ?, 'regenerate', 'succeeded', '{}', ?, ?, ?, ?)")
        .bind(id, site.siteId, site.ownerId, slot, cost, startedAt, startedAt)
        .run();
    await insert("11111111-1111-4111-8111-111111111111", 1, Date.now(), 100);
    await insert("22222222-2222-4222-8222-222222222222", 1, Date.now(), 200);
    await insert("33333333-3333-4333-8333-333333333333", 0, Date.now(), 400); // a fallback job: costs money, takes no model call
    await insert("44444444-4444-4444-8444-444444444444", 1, today - 1, 1_000); // yesterday, last millisecond
    await insert("55555555-5555-4555-8555-555555555555", 0, today - 1, 2_000);
    const view = await json<SettingsView>(await usage.call("GET", "/api/admin/settings"));
    expect(view).toMatchObject({ modelCallsToday: 2, spentTodayMicrousd: 700 });
  });
});

// STRICT (money and honesty): Spent today counts the model-slot jobs of today whose cost is not known: every one that is not finished with a
// recorded cost. Running jobs count; a model_slot 0 job (no call was sent) and yesterday's jobs do not.
describe("settings: model-slot jobs of today whose cost is unknown", () => {
  const unknown = useAdminHarness();
  type Seed = { id: string; slot: number; status: string; cost: number; startedAt: number | null; attempts?: number; errorCode?: string | null };

  async function seed(rows: Seed[]) {
    const site = await unknown.pendingSite();
    const db = await unknown.db();
    await db.prepare("UPDATE generations SET started_at = NULL").bind().run(); // the harness shares one database across this block's tests: earlier rows leave today's count
    for (const r of rows)
      await db
        .prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, model_slot, cost_microusd, attempts, error_code, created_at, started_at) VALUES (?, ?, ?, 'regenerate', ?, '{}', ?, ?, ?, ?, ?, ?)")
        .bind(r.id, site.siteId, site.ownerId, r.status, r.slot, r.cost, r.attempts ?? 0, r.errorCode ?? null, Date.now(), r.startedAt)
        .run();
    return site;
  }
  const view = async () => json<SettingsView>(await unknown.call("GET", "/api/admin/settings"));
  let run = 0; // one id range per test, because the block's tests share one database
  beforeEach(() => {
    run += 1;
  });
  const id = (n: number) => `${n}0000000-0000-4000-8000-${String(run).padStart(12, "0")}`;
  const today = Math.floor(Date.now() / 86_400_000) * 86_400_000;

  it("counts a mix: finished with a cost is known; a DraftRejected-shaped row, a swept row and a running row are unknown; model_slot 0 and yesterday's rows are not counted", async () => {
    const site = await seed([
      { id: id(1), slot: 1, status: "succeeded", cost: 336_000, startedAt: Date.now(), attempts: 1 }, // known
      { id: id(2), slot: 1, status: "failed", cost: 0, startedAt: Date.now(), attempts: 0, errorCode: "internal" }, // our own code threw after a call
      { id: id(3), slot: 1, status: "succeeded", cost: 0, startedAt: Date.now(), attempts: 0 }, // swept: starter wording after a provider error
      { id: id(4), slot: 1, status: "running", cost: 0, startedAt: Date.now() }, // still running
      { id: id(5), slot: 0, status: "failed", cost: 0, startedAt: Date.now(), errorCode: "generation_disabled" }, // no call was sent
      { id: id(6), slot: 1, status: "failed", cost: 0, startedAt: today - 1 }, // yesterday, last millisecond
    ]);
    const got = await view();
    expect(got).toMatchObject({ modelCallsToday: 4, spentTodayMicrousd: 336_000, unknownCostJobsToday: 3 });
    expect(spentTodayText(got.spentTodayMicrousd, got.modelCallsToday, got.unknownCostJobsToday)).toBe("Up to $0.34, not counting 3 jobs whose cost is unknown");
    // The site page labels each job from the same columns: it is sent model_slot with each generation.
    const detail = await json<{ generations: Array<{ id: string; status: "queued" | "running" | "succeeded" | "failed"; modelSlot: 0 | 1; costMicrousd: number }> }>(await unknown.call("GET", `/api/admin/sites/${site.siteId}`));
    const label = (n: number) => jobCostText(detail.generations.find((g) => g.id === id(n))!);
    expect([1, 2, 3, 4, 5].map(label)).toEqual(["Up to $0.34", "Cost unknown", "Cost unknown", null, "$0.00"]);
  });

  it("says Up to $X, and names no unknown job, when every model-slot job of today finished with a cost", async () => {
    await seed([{ id: id(1), slot: 1, status: "succeeded", cost: 100, startedAt: Date.now(), attempts: 1 }, { id: id(2), slot: 1, status: "failed", cost: 600_000, startedAt: Date.now(), attempts: 3 }]);
    const got = await view();
    expect(got).toMatchObject({ modelCallsToday: 2, unknownCostJobsToday: 0 });
    expect(spentTodayText(got.spentTodayMicrousd, got.modelCallsToday, got.unknownCostJobsToday)).toBe("Up to $0.61");
  });

  it("says $0.00 when no job took a model slot today (a model_slot 0 job does not count)", async () => {
    await seed([{ id: id(1), slot: 0, status: "failed", cost: 0, startedAt: Date.now(), errorCode: "generation_disabled" }]);
    const got = await view();
    expect(got).toMatchObject({ modelCallsToday: 0, spentTodayMicrousd: 0, unknownCostJobsToday: 0 });
    expect(spentTodayText(got.spentTodayMicrousd, got.modelCallsToday, got.unknownCostJobsToday)).toBe("$0.00");
  });

  it("says 1 job (singular) for exactly one running job", async () => {
    await seed([{ id: id(1), slot: 1, status: "running", cost: 0, startedAt: Date.now() }]);
    const got = await view();
    expect(got).toMatchObject({ modelCallsToday: 1, unknownCostJobsToday: 1 });
    expect(spentTodayText(got.spentTodayMicrousd, got.modelCallsToday, got.unknownCostJobsToday)).toBe("Up to $0.00, not counting 1 job whose cost is unknown");
  });
});
