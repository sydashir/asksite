import type { GenerationJob } from "@asksite/core";
import type { D1Database, Queue } from "@cloudflare/workers-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generationAllowance, requestGeneration } from "../src/request.ts";
import { utcDayStart } from "../src/settings.ts";
import { clearTables, getGeneration, insertGeneration, seedOwnerSite, setSetting, startLocalD1 } from "./support/d1.ts";
import { FULL_SNAPSHOT } from "./support/samples.ts";

const NOW = Date.UTC(2026, 8, 24, 15);

function queue(fail = false) {
  const sent: GenerationJob[] = [];
  const q = {
    async send(body: GenerationJob) {
      if (fail) throw new Error("queue down");
      sent.push(body);
    },
  } as unknown as Queue<GenerationJob>;
  return { q, sent };
}

let db: D1Database;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await startLocalD1()), 120_000);
afterAll(async () => close());
beforeEach(async () => {
  await clearTables(db);
  await seedOwnerSite(db, "o1", "s1");
  await seedOwnerSite(db, "o1", "s2");
});

const env = (q: Queue<GenerationJob>, enabled = "true", limit = "30") => ({ DB: db, GEN_QUEUE: q, GENERATION_ENABLED: enabled, DAILY_MODEL_LIMIT: limit });
const input = (siteId = "s1") => ({ siteId, ownerId: "o1", snapshot: FULL_SNAPSHOT, now: NOW });

describe("requestGeneration", () => {
  it("queues a first generation, sends { v: 1, generationId } and writes the audit row", async () => {
    const { q, sent } = queue();
    const result = await requestGeneration(env(q), input());
    expect(result).toEqual({ ok: true, generation: { id: expect.any(String), kind: "first", status: "queued", createdAt: NOW, finishedAt: null, errorCode: null, usedFallback: false, fallbackReason: null } });
    const id = result.ok ? result.generation.id : "";
    expect(sent).toEqual([{ v: 1, generationId: id }]);
    const row = await getGeneration(db, id);
    expect(JSON.parse(row.input_json)).toEqual(JSON.parse(JSON.stringify(FULL_SNAPSHOT)));
    const audit = await db.prepare("SELECT actor, action, site_id, detail_json FROM audit_log").all();
    expect(audit.results).toEqual([{ actor: "owner:o1", action: "generation.requested", site_id: "s1", detail_json: JSON.stringify({ generationId: id, kind: "first" }) }]);
  });

  it("is a regeneration once the site has a succeeded generation", async () => {
    await insertGeneration(db, { id: "old", site_id: "s1", owner_id: "o1", status: "succeeded", created_at: NOW - 86_400_000 });
    const result = await requestGeneration(env(queue().q), input());
    expect(result.ok && result.generation.kind).toBe("regenerate");
  });

  it("refuses a second job while one is queued or running (one-active index)", async () => {
    const { q, sent } = queue();
    expect((await requestGeneration(env(q), input())).ok).toBe(true);
    expect(await requestGeneration(env(q), input())).toEqual({ ok: false, code: "generation_in_progress" });
    expect(sent).toHaveLength(1);
  });

  it("allows 5 per site per UTC day; yesterday's jobs do not count", async () => {
    await insertGeneration(db, { id: "y", site_id: "s1", owner_id: "o1", status: "failed", created_at: utcDayStart(NOW) - 1 });
    for (let i = 0; i < 5; i++) await insertGeneration(db, { id: `t${i}`, site_id: "s1", owner_id: "o1", status: "failed", created_at: utcDayStart(NOW) + i });
    expect(await requestGeneration(env(queue().q), input())).toEqual({ ok: false, code: "generation_cap_reached" });
    expect((await requestGeneration(env(queue().q), input("s2"))).ok).toBe(true);
  });

  it("allows 20 regenerations per owner in total, exactly, even with two sites at once; first builds do not count and still queue at the cap", async () => {
    await insertGeneration(db, { id: "f1", site_id: "s1", owner_id: "o1", status: "succeeded", created_at: 0 });
    await insertGeneration(db, { id: "f2", site_id: "s2", owner_id: "o1", status: "succeeded", created_at: 0 });
    for (let i = 0; i < 19; i++) await insertGeneration(db, { id: `t${i}`, site_id: i % 2 ? "s1" : "s2", owner_id: "o1", kind: "regenerate", status: "failed", created_at: 0 });
    const results = await Promise.all([requestGeneration(env(queue().q), input("s1")), requestGeneration(env(queue().q), input("s2"))]);
    expect(results.filter((r) => r.ok && r.generation.kind === "regenerate")).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "generation_cap_reached")).toHaveLength(1);
    // At the cap (20 regenerations): a new site's first build still queues; a regeneration is refused.
    await seedOwnerSite(db, "o1", "s3");
    const first = await requestGeneration(env(queue().q), input("s3"));
    expect(first.ok && first.generation.kind).toBe("first");
    expect(await requestGeneration(env(queue().q), input(results[0].ok ? "s2" : "s1"))).toEqual({ ok: false, code: "generation_cap_reached" });
    expect(await generationAllowance({ DB: db }, { siteId: "s3", ownerId: "o1", now: NOW })).toEqual({ generationsLeftToday: 4, generationsLeftTotal: 0 });
  });

  it("refuses a regeneration at once when generation is switched off; a first build still queues", async () => {
    expect((await requestGeneration(env(queue().q, "false"), input("s2"))).ok).toBe(true);
    await insertGeneration(db, { id: "old", site_id: "s1", owner_id: "o1", status: "succeeded" });
    expect(await requestGeneration(env(queue().q, "false"), input())).toEqual({ ok: false, code: "generation_disabled" });
    await setSetting(db, "generation.enabled", "false");
    expect(await requestGeneration(env(queue().q), input())).toEqual({ ok: false, code: "generation_disabled" });
  });

  it("refuses a regeneration at once when today's model calls are used up; a first build still queues", async () => {
    await insertGeneration(db, { id: "used", site_id: "s2", owner_id: "o1", status: "succeeded", model_slot: 1, started_at: NOW - 1 });
    expect(await requestGeneration(env(queue().q, "true", "1"), input("s2"))).toEqual({ ok: false, code: "budget_exhausted" });
    expect((await requestGeneration(env(queue().q, "true", "1"), input("s1"))).ok).toBe(true);
  });

  it("marks the row failed and frees the site when the queue send fails", async () => {
    expect(await requestGeneration(env(queue(true).q), input())).toEqual({ ok: false, code: "internal" });
    const row = await db.prepare("SELECT status, error_code, finished_at FROM generations").first();
    expect(row).toEqual({ status: "failed", error_code: "internal", finished_at: NOW });
    expect((await requestGeneration(env(queue().q), input())).ok).toBe(true);
  });

  it("refuses a site of another owner or a taken-down site, writing and sending nothing", async () => {
    const { q, sent } = queue();
    await seedOwnerSite(db, "o2", "s3");
    expect(await requestGeneration(env(q), input("s3"))).toEqual({ ok: false, code: "internal" });
    await db.prepare("UPDATE sites SET taken_down_at = 1 WHERE id = 's1'").run();
    expect(await requestGeneration(env(q), input("s1"))).toEqual({ ok: false, code: "internal" });
    expect(sent).toEqual([]);
    expect(await db.prepare("SELECT (SELECT COUNT(*) FROM generations) + (SELECT COUNT(*) FROM audit_log) AS n").first()).toEqual({ n: 0 });
  });

  it("returns internal instead of throwing when the database fails", async () => {
    const broken = { prepare() { throw new Error("D1 down"); } } as unknown as D1Database;
    expect(await requestGeneration({ ...env(queue().q), DB: broken }, input())).toEqual({ ok: false, code: "internal" });
  });
});

describe("generationAllowance", () => {
  it("reports what is left today for the site and in total for the owner; first builds do not count toward the total", async () => {
    await insertGeneration(db, { id: "a", site_id: "s1", owner_id: "o1", kind: "regenerate", status: "failed", created_at: utcDayStart(NOW) });
    await insertGeneration(db, { id: "b", site_id: "s1", owner_id: "o1", status: "succeeded", created_at: utcDayStart(NOW) - 1 });
    await insertGeneration(db, { id: "c", site_id: "s2", owner_id: "o1", status: "succeeded", created_at: NOW });
    expect(await generationAllowance({ DB: db }, { siteId: "s1", ownerId: "o1", now: NOW })).toEqual({ generationsLeftToday: 4, generationsLeftTotal: 19 });
  });

  it("never goes below zero", async () => {
    for (let i = 0; i < 21; i++) await insertGeneration(db, { id: `t${i}`, site_id: "s1", owner_id: "o1", kind: "regenerate", status: "failed", created_at: NOW });
    expect(await generationAllowance({ DB: db }, { siteId: "s1", ownerId: "o1", now: NOW })).toEqual({ generationsLeftToday: 0, generationsLeftTotal: 0 });
  });
});
