import { livePageKey, livePointerKey, liveSitePrefix, newId, versionPageKey } from "@asksite/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { acquireLease as exportedAcquire, ADMIN_LEASE_MS, approveVersion, assertLease as exportedAssert, copyLivePagesAgain, createPendingVersion, releaseLease as exportedRelease, restore, takeDown, TAKEDOWN_REVIEW_NOTE, type PublishError } from "../src/index.ts";
import { acquireLease, releaseLease, removeOtherVersions } from "../src/shared.ts";
import { publishFailure as failure } from "./support/errors.ts";
import { auditActions, doc, EDITS, flakyBucket, liveKeysOf, pendingWithPages, publishingHarness, seedSite, siteRow, versionRow, type PublishEnv } from "./support/harness.ts";
import { isPointerKey, watchBucket, watchDb } from "./support/lease.ts";

// A16-4c: one admin action per site at a time (a lease with fencing). The clock is the `now` input of every action;
// each interleaving is a seam that runs the competing REAL function (or changes one row) at an exact point of the
// action under test, through a wrapped LIVE or DB.
const harness = publishingHarness("publishing-lease-test");
let env: PublishEnv;
beforeAll(async () => {
  env = await harness.start();
}, 120_000);
afterAll(async () => {
  await harness.server.close();
});

const ADMIN = "admin@example.com";
const OTHER = "other@example.com";
const T0 = 1_000;
const EXPIRED = T0 + ADMIN_LEASE_MS + 1; // the first instant a lease taken at T0 is over

type Built = Awaited<ReturnType<typeof pendingWithPages>>;
const approve = (p: Pick<Built, "versionId" | "htmlSha256">, now: number, e: PublishEnv = env) =>
  approveVersion(e, { versionId: p.versionId, htmlSha256: p.htmlSha256, reviewer: ADMIN, note: null, indexable: true, now });
const take = (siteId: string, now: number, e: PublishEnv = env, purgeMedia = false) => takeDown(e, { siteId, reviewer: ADMIN, reason: "Spam", purgeMedia, now });
const back = (siteId: string, expectedTakenDownAt: number, now: number, e: PublishEnv = env) => restore(e, { siteId, reviewer: ADMIN, expectedTakenDownAt, now });
const again = (siteId: string, now: number, e: PublishEnv = env) => copyLivePagesAgain(e, { siteId, reviewer: ADMIN, now });

async function liveSite(pages?: Parameters<typeof pendingWithPages>[1]): Promise<Built> {
  const p = await pendingWithPages(env, pages);
  await approve(p, 2);
  return p;
}
/** A live site with a second version in review. */
async function liveWithPending() {
  const p = await liveSite();
  const v2 = await createPendingVersion(env, { siteId: p.siteId, ownerId: p.ownerId, slug: p.slug, document: doc("hvac-phoenix"), edits: EDITS, generationId: null, now: 3 });
  return { ...p, v2: { versionId: v2.id, htmlSha256: String((await versionRow(env.DB, v2.id))?.html_sha256) } };
}
const lockOf = (siteId: string) => env.DB.prepare("SELECT admin_lock, admin_lock_until FROM sites WHERE id = ?").bind(siteId).first<{ admin_lock: string | null; admin_lock_until: number | null }>();
/** Another action takes the site's lease over (as one would once the holder's lease ran out). */
const steal = (siteId: string) => env.DB.prepare("UPDATE sites SET admin_lock = 'thief', admin_lock_until = 9000000000000 WHERE id = ?").bind(siteId).run().then(() => undefined);
const snapshot = async (p: { siteId: string; slug: string }) => ({ site: await siteRow(env.DB, p.siteId), audit: await auditActions(env.DB, p.siteId), keys: await liveKeysOf(env.LIVE, p.slug) });
const detailOf = (error: PublishError) => ({ code: error.code, detail: error.detail });

describe("acquireLease and releaseLease", () => {
  it("is busy until the lease is over, then the next action takes it, and answers how long to wait", async () => {
    const s = await seedSite(env.DB);
    const token = await acquireLease(env.DB, s.siteId, T0, "site_not_found");
    expect(await lockOf(s.siteId)).toEqual({ admin_lock: token, admin_lock_until: T0 + ADMIN_LEASE_MS });
    expect(ADMIN_LEASE_MS).toBe(120_000);
    const busy = (now: number) => failure(acquireLease(env.DB, s.siteId, now, "site_not_found"));
    expect(detailOf(await busy(T0))).toEqual({ code: "site_busy", detail: { retryAfter: 120 } });
    expect((await busy(T0 + 119_500)).detail).toEqual({ retryAfter: 1 });
    expect((await busy(T0 + ADMIN_LEASE_MS)).code).toBe("site_busy"); // the last instant of the lease
    const next = await acquireLease(env.DB, s.siteId, EXPIRED, "site_not_found");
    expect(next).not.toBe(token);
    expect(await lockOf(s.siteId)).toEqual({ admin_lock: next, admin_lock_until: EXPIRED + ADMIN_LEASE_MS });
  });

  it("answers the action's own error for a site that does not exist", async () => {
    expect((await failure(acquireLease(env.DB, newId(), T0, "site_not_found"))).code).toBe("site_not_found");
    expect((await failure(acquireLease(env.DB, newId(), T0, "version_not_pending"))).code).toBe("version_not_pending");
  });

  it("releases only its own token: a wrong token changes nothing, and a takeover is not cleared by the old holder", async () => {
    const s = await seedSite(env.DB);
    const token = await acquireLease(env.DB, s.siteId, T0, "site_not_found");
    await releaseLease(env.DB, s.siteId, "not-the-token");
    expect(await lockOf(s.siteId)).toEqual({ admin_lock: token, admin_lock_until: T0 + ADMIN_LEASE_MS });
    const taker = await acquireLease(env.DB, s.siteId, EXPIRED, "site_not_found");
    await releaseLease(env.DB, s.siteId, token); // the first holder finishes late
    expect(await lockOf(s.siteId)).toEqual({ admin_lock: taker, admin_lock_until: EXPIRED + ADMIN_LEASE_MS });
    await releaseLease(env.DB, s.siteId, taker);
    expect(await lockOf(s.siteId)).toEqual({ admin_lock: null, admin_lock_until: null });
  });

  it("logs a release that fails and never throws it", async () => {
    const s = await seedSite(env.DB);
    const failing = watchDb(env.DB, async () => {
      throw new Error("D1 is unavailable");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await releaseLease(failing, s.siteId, "t");
      expect(logged.mock.calls.map((c) => String(c[0]))).toEqual([JSON.stringify({ code: "lease_release_failed", siteId: s.siteId })]);
    } finally {
      logged.mockRestore();
    }
  });

  it("is exported by the package entry for Plan 4's ops sweep, and an expired lease is taken over", async () => {
    const s = await seedSite(env.DB);
    const a = await exportedAcquire(env.DB, s.siteId, T0, "site_not_found");
    expect(detailOf(await failure(exportedAcquire(env.DB, s.siteId, T0 + 1, "site_not_found")))).toEqual({ code: "site_busy", detail: { retryAfter: 120 } });
    const b = await exportedAcquire(env.DB, s.siteId, EXPIRED, "site_not_found");
    expect(b).not.toBe(a);
    expect(detailOf(await failure(exportedAssert(env.DB, s.siteId, a)))).toEqual({ code: "site_busy", detail: { reason: "lease_lost" } });
    await exportedAssert(env.DB, s.siteId, b);
    await exportedRelease(env.DB, s.siteId, a);
    expect((await lockOf(s.siteId))?.admin_lock).toBe(b);
    await exportedRelease(env.DB, s.siteId, b);
    expect(await lockOf(s.siteId)).toEqual({ admin_lock: null, admin_lock_until: null });
  });

  it("every action frees the site when it ends, by result or by error", async () => {
    const p = await liveWithPending();
    await take(p.siteId, 10);
    expect((await lockOf(p.siteId))?.admin_lock).toBeNull();
    await failure(back(p.siteId, 99, 11)); // taken_down_again
    await back(p.siteId, 10, 12);
    await again(p.siteId, 13);
    await failure(approve(p.v2, 14)); // the takedown rejected it: version_not_pending
    expect(await lockOf(p.siteId)).toEqual({ admin_lock: null, admin_lock_until: null });
  });
});

describe("two actions on one site (test 1)", () => {
  /** Runs `hold` with a LIVE that calls `intrude` once at the holder's first `on` of the pointer; the intruder must be busy and change nothing. */
  async function intrusion(p: { siteId: string; slug: string }, hold: (e: PublishEnv) => Promise<unknown>, intrude: () => Promise<unknown>, on: "put" | "delete") {
    let seen: { busy: PublishError; before: unknown; after: unknown } | undefined;
    let running = false;
    const live = watchBucket(env.LIVE, async (call, arg) => {
      if (call !== on || !isPointerKey(p.slug, arg) || running) return;
      running = true;
      const before = await snapshot(p);
      const busy = await failure(intrude());
      seen = { busy, before, after: await snapshot(p) };
    });
    await hold({ ...env, LIVE: live });
    expect(seen).toBeDefined();
    expect(detailOf(seen?.busy as PublishError)).toEqual({ code: "site_busy", detail: { retryAfter: 120 } });
    expect(seen?.after).toEqual(seen?.before);
  }

  it("approve holds: a takedown in its pointer write is busy and changes nothing; after approve ends the takedown succeeds", async () => {
    const p = await pendingWithPages(env);
    await intrusion(p, (e) => approve(p, T0, e), () => take(p.siteId, T0), "put");
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ live_version_id: p.versionId, taken_down_at: null });
    await take(p.siteId, T0 + 1);
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: T0 + 1 });
    expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([]);
  });

  it("approve holds: a restore in its pointer write is busy", async () => {
    const p = await pendingWithPages(env);
    await intrusion(p, (e) => approve(p, T0, e), () => back(p.siteId, 5, T0), "put");
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ live_version_id: p.versionId });
  });

  it("restore holds: a copy-again in its pointer write is busy; after restore ends the copy-again succeeds", async () => {
    const p = await liveSite();
    await take(p.siteId, 50);
    await intrusion(p, (e) => back(p.siteId, 50, T0, e), () => again(p.siteId, T0), "put");
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: null });
    expect(await again(p.siteId, T0 + 1)).toEqual({ liveUrl: `https://${p.slug}.asksite.example/` });
  });

  it("copy-again holds: a restore in its pointer write is busy", async () => {
    const p = await liveSite();
    await intrusion(p, (e) => again(p.siteId, T0, e), () => back(p.siteId, 5, T0), "put");
  });

  it("takedown holds: an approve of the version in review, in its first pointer delete, is busy", async () => {
    const p = await liveWithPending();
    await intrusion(p, (e) => take(p.siteId, T0, e), () => approve(p.v2, T0), "delete");
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: T0, live_version_id: p.versionId });
    expect(await versionRow(env.DB, p.v2.versionId)).toMatchObject({ status: "rejected", review_note: TAKEDOWN_REVIEW_NOTE });
  });

  it("another site is never busy because of this one", async () => {
    const a = await pendingWithPages(env);
    const b = await pendingWithPages(env);
    let other: Promise<unknown> | undefined;
    const live = watchBucket(env.LIVE, async (call, arg) => {
      if (call === "put" && isPointerKey(a.slug, arg) && other === undefined) other = approve(b, T0);
    });
    await approve(a, T0, { ...env, LIVE: live });
    await other;
    expect((await siteRow(env.DB, b.siteId))?.live_version_id).toBe(b.versionId);
  });
});

describe("a lease that ran out is fenced (test 2)", () => {
  it("approve: another action takes over before its batch; its fenced write changes nothing and it throws lease_lost; D1 and LIVE end in the taker's state", async () => {
    const p = await pendingWithPages(env);
    let ran = false;
    const db = watchDb(env.DB, async ({ method }) => {
      if (method !== "batch" || ran) return;
      ran = true;
      await take(p.siteId, EXPIRED); // B: real takeDown, the lease of A (taken at T0) is over
    });
    const error = await failure(approve(p, T0, { ...env, DB: db }));
    expect(detailOf(error)).toEqual({ code: "site_busy", detail: { reason: "lease_lost" } });
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: EXPIRED, live_version_id: null, pending_version_id: null });
    expect(await versionRow(env.DB, p.versionId)).toMatchObject({ status: "rejected", review_note: TAKEDOWN_REVIEW_NOTE });
    expect(await auditActions(env.DB, p.siteId)).toEqual(["version.requested", "site.taken_down"]);
    expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([]);
    expect((await lockOf(p.siteId))?.admin_lock).toBeNull();
  });

  it("approve: its lease re-check stops it before the pointer write", async () => {
    const p = await pendingWithPages(env);
    let ran = false;
    const calls: Array<{ call: string; arg: unknown }> = [];
    const db = watchDb(env.DB, async ({ method, sql }) => {
      if (ran || method !== "first" || !sql.startsWith("SELECT admin_lock FROM sites")) return;
      ran = true; // the first one is the re-check after the batch
      await take(p.siteId, EXPIRED);
    });
    const error = await failure(approve(p, T0, { ...env, DB: db, LIVE: watchBucket(env.LIVE, undefined, calls) }));
    expect(detailOf(error)).toEqual({ code: "site_busy", detail: { reason: "lease_lost" } });
    expect(calls.filter((c) => c.call === "put" && isPointerKey(p.slug, c.arg))).toEqual([]);
    expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([]);
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: EXPIRED, live_version_id: p.versionId });
  });

  it("the old holder's finish does not clear the taker's lease (a fenced write lost, the taker still holds)", async () => {
    const p = await pendingWithPages(env);
    const db = watchDb(env.DB, async ({ method }) => {
      if (method === "batch") await steal(p.siteId);
    });
    expect((await failure(approve(p, T0, { ...env, DB: db }))).detail).toEqual({ reason: "lease_lost" });
    expect((await lockOf(p.siteId))?.admin_lock).toBe("thief");
  });
});

describe("every fenced statement and every pointer re-check", () => {
  const stealOnBatch = (siteId: string, nth = 1) => {
    let n = 0;
    return watchDb(env.DB, async ({ method }) => {
      if (method === "batch" && ++n === nth) await steal(siteId);
    });
  };
  /** A DB that steals the lease at the nth read of admin_lock (the re-checks, in order). */
  const stealAtCheck = (siteId: string, nth: number) => {
    let n = 0;
    return watchDb(env.DB, async ({ method, sql }) => {
      if (method === "first" && sql.startsWith("SELECT admin_lock FROM sites") && ++n === nth) await steal(siteId);
    });
  };
  const lost = { code: "site_busy", detail: { reason: "lease_lost" } };

  it("approve's sites UPDATE carries the lease", async () => {
    const p = await pendingWithPages(env);
    expect(detailOf(await failure(approve(p, T0, { ...env, DB: stealOnBatch(p.siteId) })))).toEqual(lost);
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ live_version_id: null, pending_version_id: p.versionId });
    expect(await versionRow(env.DB, p.versionId)).toMatchObject({ status: "pending" });
    expect(await auditActions(env.DB, p.siteId)).toEqual(["version.requested"]);
  });

  it("approve's site_versions UPDATE carries the lease too (a state the sites UPDATE cannot change)", async () => {
    const p = await pendingWithPages(env);
    // After the pre-checks the site already shows this version live and nothing pending (as if it had just been made live).
    const db = watchDb(env.DB, async ({ method }) => {
      if (method !== "batch") return;
      await env.DB.prepare("UPDATE sites SET pending_version_id = NULL, live_version_id = ? WHERE id = ?").bind(p.versionId, p.siteId).run();
      await steal(p.siteId);
    });
    expect(detailOf(await failure(approve(p, T0, { ...env, DB: db })))).toEqual(lost);
    expect(await versionRow(env.DB, p.versionId)).toMatchObject({ status: "pending", reviewed_by: null });
    expect(await auditActions(env.DB, p.siteId)).toEqual(["version.requested"]);
  });

  it("approve re-checks the lease right before the pointer write", async () => {
    const p = await pendingWithPages(env);
    const calls: Array<{ call: string; arg: unknown }> = [];
    const error = await failure(approve(p, T0, { ...env, DB: stealAtCheck(p.siteId, 1), LIVE: watchBucket(env.LIVE, undefined, calls) }));
    expect(detailOf(error)).toEqual(lost);
    expect(calls.filter((c) => c.call === "put" && isPointerKey(p.slug, c.arg))).toEqual([]);
  });

  describe("takeDown", () => {
    const setup = async () => {
      const p = await liveWithPending();
      await env.DB.prepare("INSERT INTO uploads (id, site_id, width, height, bytes, created_at) VALUES (?, ?, 1, 1, 4, 1)").bind(newId(), p.siteId).run();
      return p;
    };
    const deletes = (calls: Array<{ call: string; arg: unknown }>) => calls.filter((c) => c.call === "delete");

    it("re-checks the lease before the first pointer delete: it touches nothing", async () => {
      const p = await setup();
      const before = await snapshot(p);
      const calls: Array<{ call: string; arg: unknown }> = [];
      expect(detailOf(await failure(take(p.siteId, T0, { ...env, DB: stealAtCheck(p.siteId, 1), LIVE: watchBucket(env.LIVE, undefined, calls) })))).toEqual(lost);
      expect(deletes(calls)).toEqual([]);
      expect(await snapshot(p)).toEqual(before);
    });

    it("fences the sites UPDATE and the pending version's reject", async () => {
      const p = await setup();
      expect(detailOf(await failure(take(p.siteId, T0, { ...env, DB: stealOnBatch(p.siteId) })))).toEqual(lost);
      expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: null, pending_version_id: p.v2.versionId });
      expect(await versionRow(env.DB, p.v2.versionId)).toMatchObject({ status: "pending", reviewed_by: null });
      expect(await auditActions(env.DB, p.siteId)).not.toContain("site.taken_down");
    });

    it("re-checks the lease after a zero-row batch on a site with no slug (the only check left there)", async () => {
      const s = await seedSite(env.DB);
      await env.DB.prepare("UPDATE sites SET slug = NULL WHERE id = ?").bind(s.siteId).run();
      expect(detailOf(await failure(take(s.siteId, T0, { ...env, DB: stealOnBatch(s.siteId) })))).toEqual(lost);
      expect(await siteRow(env.DB, s.siteId)).toMatchObject({ taken_down_at: null });
      expect(await auditActions(env.DB, s.siteId)).not.toContain("site.taken_down");
    });

    it("re-checks the lease before the second pointer delete", async () => {
      const p = await setup();
      const calls: Array<{ call: string; arg: unknown }> = [];
      expect(detailOf(await failure(take(p.siteId, T0, { ...env, DB: stealAtCheck(p.siteId, 2), LIVE: watchBucket(env.LIVE, undefined, calls) })))).toEqual(lost);
      expect(deletes(calls).filter((c) => isPointerKey(p.slug, c.arg))).toHaveLength(1); // the first only
      expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: T0 }); // the batch was the holder's, done
    });

    it("re-checks the lease before the prefix delete", async () => {
      const p = await setup();
      const calls: Array<{ call: string; arg: unknown }> = [];
      expect(detailOf(await failure(take(p.siteId, T0, { ...env, DB: stealAtCheck(p.siteId, 3), LIVE: watchBucket(env.LIVE, undefined, calls) })))).toEqual(lost);
      expect(deletes(calls).filter((c) => !isPointerKey(p.slug, c.arg))).toEqual([]);
      expect((await liveKeysOf(env.LIVE, p.slug)).length).toBeGreaterThan(0); // the pages are still there
    });

    it("fences the uploads UPDATE of the media purge", async () => {
      const p = await setup();
      expect(detailOf(await failure(take(p.siteId, T0, { ...env, DB: stealOnBatch(p.siteId, 2) }, true)))).toEqual(lost);
      const { results } = await env.DB.prepare("SELECT deleted_at FROM uploads WHERE site_id = ?").bind(p.siteId).all<{ deleted_at: number | null }>();
      expect(results.map((r) => r.deleted_at)).toEqual([null]);
    });
  });

  describe("restore", () => {
    const downSite = async () => {
      const p = await liveSite();
      await take(p.siteId, 50);
      return p;
    };

    it("re-checks the lease before the pointer write: no pointer, still down", async () => {
      const p = await downSite();
      const calls: Array<{ call: string; arg: unknown }> = [];
      expect(detailOf(await failure(back(p.siteId, 50, T0, { ...env, DB: stealAtCheck(p.siteId, 1), LIVE: watchBucket(env.LIVE, undefined, calls) })))).toEqual(lost);
      expect(calls.filter((c) => c.call === "put" && isPointerKey(p.slug, c.arg))).toEqual([]);
      expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: 50 });
    });

    it("fences the clear: with the lease lost the site stays down and its pointer is taken back out", async () => {
      const p = await downSite();
      const audit = await auditActions(env.DB, p.siteId);
      expect(detailOf(await failure(back(p.siteId, 50, T0, { ...env, DB: stealOnBatch(p.siteId) })))).toEqual(lost);
      expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: 50 });
      expect(await auditActions(env.DB, p.siteId)).toEqual(audit);
      expect(await env.LIVE.head(livePointerKey(p.slug))).toBeNull();
    });

    it.each([
      ["a takedown time that is not the expected one", (p: Built) => env.DB.prepare("UPDATE sites SET taken_down_at = 77 WHERE id = ?").bind(p.siteId).run()],
      ["a live version that is not the copied one", (p: Built) => env.DB.prepare("UPDATE sites SET live_version_id = ? WHERE id = ?").bind(newId(), p.siteId).run()],
    ])("clears only %s: otherwise the pointer is taken back out and it throws lease_lost", async (_name, change) => {
      const p = await downSite();
      let changed = false;
      const db = watchDb(env.DB, async ({ method }) => {
        if (method !== "batch") return;
        changed = true;
        await change(p);
      });
      expect(detailOf(await failure(back(p.siteId, 50, T0, { ...env, DB: db })))).toEqual(lost);
      expect(changed).toBe(true);
      expect(await env.LIVE.head(livePointerKey(p.slug))).toBeNull();
      expect(await auditActions(env.DB, p.siteId)).not.toContain("site.restored");
    });

    it("takes the pointer back out when the clear throws, and rethrows", async () => {
      const p = await downSite();
      const db = watchDb(env.DB, async ({ method }) => {
        if (method === "batch") throw new Error("D1 is unavailable");
      });
      await expect(back(p.siteId, 50, T0, { ...env, DB: db })).rejects.toThrow("D1 is unavailable");
      expect(await env.LIVE.head(livePointerKey(p.slug))).toBeNull();
      expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: 50 });
    });

    it("logs it when that pointer delete fails too", async () => {
      const p = await downSite();
      const db = watchDb(env.DB, async ({ method }) => {
        if (method === "batch") throw new Error("D1 is unavailable");
      });
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const noDelete = flakyBucket(env.LIVE, (call) => call === "delete");
        await expect(back(p.siteId, 50, T0, { ...env, DB: db, LIVE: noDelete })).rejects.toThrow("D1 is unavailable");
        expect(logged.mock.calls.map((c) => String(c[0]))).toContainEqual(JSON.stringify({ code: "takedown_pointer_left", siteId: p.siteId, versionId: p.versionId }));
      } finally {
        logged.mockRestore();
      }
      await take(p.siteId, 60); // the takedown's retry removes it
      expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([]);
    });

    describe("a clear that throws (D1 can commit a batch and still throw)", () => {
      const clears = (sql: string) => sql.includes("taken_down_at = NULL");
      const timesOut = async ({ method, sql }: { method: string; sql: string }) => {
        if (method === "batch" && clears(sql)) throw new Error("D1 timed out");
      };

      it("a clear that committed and then threw keeps the pointer and succeeds: live, one site.restored row, lease released", async () => {
        const p = await downSite();
        const db = watchDb(env.DB, async () => {}, timesOut);
        const result = await back(p.siteId, 50, T0, { ...env, DB: db });
        expect(result).toEqual({ liveUrl: `https://${p.slug}.asksite.example/`, missingPhotos: 0, healed: false });
        expect((await env.LIVE.head(livePointerKey(p.slug)))?.customMetadata?.["versionId"]).toBe(p.versionId);
        expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: null, live_version_id: p.versionId });
        expect((await auditActions(env.DB, p.siteId)).filter((a) => a === "site.restored")).toHaveLength(1);
        expect(await lockOf(p.siteId)).toEqual({ admin_lock: null, admin_lock_until: null });
      });

      it("a clear that threw and a re-read that throws too: the pointer is taken back out, still down (it may have committed: the retry heals), the original error", async () => {
        const p = await downSite();
        const db = watchDb(env.DB, async ({ method, sql }) => {
          if (method === "batch" && clears(sql)) throw new Error("D1 timed out");
          if (method === "first" && sql.startsWith("SELECT taken_down_at, live_version_id FROM sites")) throw new Error("D1 is unavailable");
        });
        await expect(back(p.siteId, 50, T0, { ...env, DB: db })).rejects.toThrow("D1 timed out");
        expect(await env.LIVE.head(livePointerKey(p.slug))).toBeNull();
        expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: 50 });
      });

      it("a clear that committed under a lost lease, with another version live: the pointer is left alone and it throws lease_lost", async () => {
        const p = await downSite();
        const other = newId();
        const db = watchDb(env.DB, async () => {}, async ({ method, sql }) => {
          if (method === "batch" && clears(sql)) {
            await env.DB.prepare("UPDATE sites SET live_version_id = ? WHERE id = ?").bind(other, p.siteId).run();
            throw new Error("D1 timed out");
          }
        });
        expect(detailOf(await failure(back(p.siteId, 50, T0, { ...env, DB: db })))).toEqual(lost);
        expect((await env.LIVE.head(livePointerKey(p.slug)))?.customMetadata?.["versionId"]).toBe(p.versionId);
      });
    });

    describe("a pointer write that rejects", () => {
      /** The pointer put runs on the real bucket (landing or not) and then rejects, as a timeout after the write would. */
      const rejectingPut = (slug: string, lands: boolean): R2Bucket => {
        const put = (...args: Parameters<R2Bucket["put"]>) =>
          args[0] === livePointerKey(slug) ? (lands ? env.LIVE.put(...args) : Promise.resolve(null)).then(() => Promise.reject(new Error("R2 timed out"))) : env.LIVE.put(...args);
        return { ...watchBucket(env.LIVE), put } as unknown as R2Bucket;
      };
      const expectStillDown = async (p: Built, audit: string[]) => {
        expect(await env.LIVE.head(livePointerKey(p.slug))).toBeNull();
        expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: 50 });
        expect(await auditActions(env.DB, p.siteId)).toEqual(audit);
        expect(await lockOf(p.siteId)).toEqual({ admin_lock: null, admin_lock_until: null });
      };

      it.each([
        ["lands and then rejects", true],
        ["rejects without landing", false],
      ])("a put that %s: the pointer is taken back out, live_copy_failed, still down, retry-safe", async (_name, lands) => {
        const p = await downSite();
        const audit = await auditActions(env.DB, p.siteId);
        expect(detailOf(await failure(back(p.siteId, 50, T0, { ...env, LIVE: rejectingPut(p.slug, lands) })))).toEqual({ code: "live_copy_failed", detail: { versionId: p.versionId } });
        await expectStillDown(p, audit);
        await back(p.siteId, 50, T0 + 1); // the admin restores again with the same expectedTakenDownAt
        expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: null });
      });

      it("the lease lost during a put that lands and rejects: the pointer is still taken back out", async () => {
        const p = await downSite();
        const put = (...args: Parameters<R2Bucket["put"]>) =>
          args[0] === livePointerKey(p.slug) ? env.LIVE.put(...args).then(() => steal(p.siteId)).then(() => Promise.reject(new Error("R2 timed out"))) : env.LIVE.put(...args);
        const error = await failure(back(p.siteId, 50, T0, { ...env, LIVE: { ...watchBucket(env.LIVE), put } as unknown as R2Bucket }));
        expect(await env.LIVE.head(livePointerKey(p.slug))).toBeNull(); // the take-back is deliberately not lease-checked
        expect(detailOf(error)).toEqual({ code: "live_copy_failed", detail: { versionId: p.versionId } });
        expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: 50 });
      });

      it("answers live_copy_failed, never the delete's error, and logs the pointer left when the take-back fails too", async () => {
        const p = await downSite();
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          const noDelete = flakyBucket(rejectingPut(p.slug, true), (call) => call === "delete");
          expect(detailOf(await failure(back(p.siteId, 50, T0, { ...env, LIVE: noDelete })))).toEqual({ code: "live_copy_failed", detail: { versionId: p.versionId } });
          expect(logged.mock.calls.map((c) => String(c[0]))).toEqual([JSON.stringify({ code: "takedown_pointer_left", siteId: p.siteId, versionId: p.versionId })]);
        } finally {
          logged.mockRestore();
        }
        await take(p.siteId, 60); // the takedown's retry removes it
        expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([]);
      });
    });
  });

  describe("copyLivePagesAgain", () => {
    it("re-checks the lease before the pointer write", async () => {
      const p = await liveSite();
      const calls: Array<{ call: string; arg: unknown }> = [];
      expect(detailOf(await failure(again(p.siteId, T0, { ...env, DB: stealAtCheck(p.siteId, 1), LIVE: watchBucket(env.LIVE, undefined, calls) })))).toEqual(lost);
      expect(calls.filter((c) => c.call === "put" && isPointerKey(p.slug, c.arg))).toEqual([]);
    });

    it("a takedown that commits between the pointer put and the re-read: the pointer is taken back out and it is site_taken_down", async () => {
      const p = await liveSite();
      const live = watchBucket(env.LIVE, async (call, arg) => {
        if (call === "put" && isPointerKey(p.slug, arg)) await take(p.siteId, EXPIRED); // the lease outlived: the takedown's deletes ran before this put lands
      });
      expect((await failure(again(p.siteId, T0, { ...env, LIVE: live }))).code).toBe("site_taken_down");
      expect(await env.LIVE.head(livePointerKey(p.slug))).toBeNull();
      expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: EXPIRED });
    });

    it("a re-read that throws takes the pointer out and is live_copy_failed", async () => {
      const p = await liveSite();
      const db = watchDb(env.DB, async ({ method, sql }) => {
        if (method === "first" && sql.startsWith("SELECT taken_down_at FROM sites")) throw new Error("D1 is unavailable");
      });
      expect(detailOf(await failure(again(p.siteId, T0, { ...env, DB: db })))).toEqual({ code: "live_copy_failed", detail: { versionId: p.versionId } });
      expect(await env.LIVE.head(livePointerKey(p.slug))).toBeNull();
    });

    it("a put that lands and rejects on a live site is live_copy_failed, and the pointer that landed stays (the site is live and it names its live version)", async () => {
      const p = await liveSite();
      const live = {
        ...watchBucket(env.LIVE),
        put: async (...args: Parameters<R2Bucket["put"]>) => {
          const stored = await env.LIVE.put(...args);
          if (isPointerKey(p.slug, args[0])) throw new Error("R2 timed out");
          return stored;
        },
      } as unknown as R2Bucket;
      expect(detailOf(await failure(again(p.siteId, T0, { ...env, LIVE: live })))).toEqual({ code: "live_copy_failed", detail: { versionId: p.versionId } });
      expect((await env.LIVE.head(livePointerKey(p.slug)))?.customMetadata?.["versionId"]).toBe(p.versionId);
    });

    it("a put that lands, meets a takedown, then rejects: the pointer is taken back out and it is site_taken_down", async () => {
      const p = await liveSite();
      let landed = false;
      const live = {
        ...watchBucket(env.LIVE),
        put: async (...args: Parameters<R2Bucket["put"]>) => {
          if (!isPointerKey(p.slug, args[0])) return env.LIVE.put(...args);
          await take(p.siteId, EXPIRED); // the lease outlived: the takedown's deletes ran before this put lands
          await env.LIVE.put(...args);
          landed = (await env.LIVE.head(livePointerKey(p.slug))) !== null;
          throw new Error("R2 timed out");
        },
      } as unknown as R2Bucket;
      expect((await failure(again(p.siteId, T0, { ...env, LIVE: live }))).code).toBe("site_taken_down");
      expect(landed).toBe(true); // the pointer was back on the down site: only the take-back removes it
      expect(await env.LIVE.head(livePointerKey(p.slug))).toBeNull();
      expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: EXPIRED });
    });
  });
});

describe("restore of an already-restored site heals its pointer", () => {
  const pointerOf = async (slug: string) => (await env.LIVE.head(livePointerKey(slug)))?.customMetadata;

  it("a live site whose pointer is missing: the pointer is back with the right version and business, healed, no D1 change, no audit row", async () => {
    const p = await liveSite();
    const meta = await pointerOf(p.slug);
    const before = await snapshot(p);
    await env.LIVE.delete(livePointerKey(p.slug));
    const result = await back(p.siteId, 12345, 70);
    expect(await pointerOf(p.slug)).toEqual(meta);
    expect(meta?.["versionId"]).toBe(p.versionId);
    expect(result).toEqual({ liveUrl: `https://${p.slug}.asksite.example/`, missingPhotos: 0, healed: true });
    expect(await snapshot(p)).toEqual(before);
  });

  it("a live site whose pointer names another version: rewritten, healed", async () => {
    const p = await liveSite();
    const meta = await pointerOf(p.slug);
    await env.LIVE.put(livePointerKey(p.slug), "", { customMetadata: { ...meta, versionId: newId() } });
    const result = await back(p.siteId, 1, 70);
    expect(await pointerOf(p.slug)).toEqual(meta);
    expect(result.healed).toBe(true);
  });

  it("a live site with a correct pointer: healed false and no LIVE write", async () => {
    const p = await liveSite();
    const calls: Array<{ call: string; arg: unknown }> = [];
    expect((await back(p.siteId, 1, 70, { ...env, LIVE: watchBucket(env.LIVE, undefined, calls) })).healed).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("the restore of a taken-down site (tests 4 and 5)", () => {
  it("the Critical: a restore that was shown the first takedown refuses once the site was restored and taken down again", async () => {
    const p = await liveSite();
    await take(p.siteId, 50); // T1
    await back(p.siteId, 50, 60); // another admin restores
    await take(p.siteId, 70); // and a third takes it down again: T2
    const before = await snapshot(p);
    const calls: Array<{ call: string; arg: unknown }> = [];
    const error = await failure(back(p.siteId, 50, 80, { ...env, LIVE: watchBucket(env.LIVE, undefined, calls) }));
    expect(detailOf(error)).toEqual({ code: "site_taken_down", detail: { reason: "taken_down_again" } });
    expect(calls).toEqual([]); // no LIVE object written (or listed, or deleted)
    expect(await snapshot(p)).toEqual(before);
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ taken_down_at: 70 });
    expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([]);
    expect((await auditActions(env.DB, p.siteId)).filter((a) => a === "site.restored")).toHaveLength(1); // the other admin's, none from this one
    await back(p.siteId, 70, 90); // reloaded, the admin restores the second takedown
    expect((await siteRow(env.DB, p.siteId))?.taken_down_at).toBeNull();
  });

  it("a site that is already restored gives the normal result and changes nothing", async () => {
    const p = await liveSite();
    await take(p.siteId, 50);
    const first = await back(p.siteId, 50, 60);
    const before = await snapshot(p);
    const calls: Array<{ call: string; arg: unknown }> = [];
    expect(await back(p.siteId, 50, 61, { ...env, LIVE: watchBucket(env.LIVE, undefined, calls) })).toEqual(first);
    expect(calls).toEqual([]);
    expect(await snapshot(p)).toEqual(before);
  });

  it("answers site_not_found, then not_live, before the takedown time is looked at", async () => {
    expect((await failure(back(newId(), 1, 1))).code).toBe("site_not_found");
    const never = await seedSite(env.DB);
    await take(never.siteId, 5);
    expect((await failure(back(never.siteId, 5, 6))).code).toBe("not_live");
  });
});

describe("copyLivePagesAgain (test 6)", () => {
  it("a taken-down site is site_taken_down and nothing is written", async () => {
    const p = await liveSite();
    await take(p.siteId, 50);
    const before = await snapshot(p);
    const calls: Array<{ call: string; arg: unknown }> = [];
    expect((await failure(again(p.siteId, T0, { ...env, LIVE: watchBucket(env.LIVE, undefined, calls) }))).code).toBe("site_taken_down");
    expect(calls).toEqual([]);
    expect(await snapshot(p)).toEqual(before);
  });

  it("a live site gets every page and the pointer back, with no D1 change and no audit row", async () => {
    const p = await liveSite(["home", "services", "about", "contact"]);
    await env.LIVE.delete([livePointerKey(p.slug), livePageKey(p.slug, p.versionId, "about")]);
    const before = { ...(await snapshot(p)), version: await versionRow(env.DB, p.versionId), updated: await env.DB.prepare("SELECT updated_at FROM sites WHERE id = ?").bind(p.siteId).first() };
    expect(await again(p.siteId, 99)).toEqual({ liveUrl: `https://${p.slug}.asksite.example/` });
    expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([livePointerKey(p.slug), ...p.pages.map((page) => livePageKey(p.slug, p.versionId, page.page))].sort());
    const after = { ...(await snapshot(p)), version: await versionRow(env.DB, p.versionId), updated: await env.DB.prepare("SELECT updated_at FROM sites WHERE id = ?").bind(p.siteId).first() };
    expect({ ...after, keys: before.keys }).toEqual(before);
  });

  it("a rejected pointer write is live_copy_failed, and calling it again finishes", async () => {
    const p = await liveSite();
    await env.LIVE.delete(livePointerKey(p.slug));
    const failing = flakyBucket(env.LIVE, (call, key) => call === "put" && key === livePointerKey(p.slug));
    const error = await failure(again(p.siteId, T0, { ...env, LIVE: failing }));
    expect(detailOf(error)).toEqual({ code: "live_copy_failed", detail: { versionId: p.versionId } });
    expect(await env.LIVE.head(livePointerKey(p.slug))).toBeNull();
    await again(p.siteId, T0 + 1);
    expect((await env.LIVE.head(livePointerKey(p.slug)))?.customMetadata?.["versionId"]).toBe(p.versionId);
  });

  it("answers site_not_found and not_live", async () => {
    expect((await failure(again(newId(), 1))).code).toBe("site_not_found");
    const site = await seedSite(env.DB);
    expect((await failure(again(site.siteId, 1))).code).toBe("not_live");
  });

  it("refuses damaged stored bytes and writes nothing", async () => {
    const p = await liveSite();
    await env.WORK.put(versionPageKey(p.siteId, p.versionId, "services"), "<p>tampered</p>");
    const calls: Array<{ call: string; arg: unknown }> = [];
    expect((await failure(again(p.siteId, T0, { ...env, LIVE: watchBucket(env.LIVE, undefined, calls) }))).code).toBe("integrity");
    expect(calls).toEqual([]);
  });
});

describe("approve's re-check after the pointer write (test 7)", () => {
  /** A LIVE whose pointer put lands and then rejects (a timeout after the write), running `after` in between. */
  const landsThenRejects = (slug: string, after: () => Promise<void> = async () => {}): R2Bucket =>
    ({
      ...watchBucket(env.LIVE),
      put: async (...args: Parameters<R2Bucket["put"]>) => {
        const stored = await env.LIVE.put(...args);
        if (isPointerKey(slug, args[0])) {
          await after();
          throw new Error("R2 timed out");
        }
        return stored;
      },
    }) as unknown as R2Bucket;
  const logs = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("a put that landed and rejected on a site that is not down is live_copy_failed; approving again heals it", async () => {
    const p = await pendingWithPages(env);
    const error = await failure(approve(p, T0, { ...env, LIVE: landsThenRejects(p.slug) }));
    expect(detailOf(error)).toEqual({ code: "live_copy_failed", detail: { versionId: p.versionId } });
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ live_version_id: p.versionId });
    expect((await env.LIVE.head(livePointerKey(p.slug)))?.customMetadata?.["versionId"]).toBe(p.versionId);
    await env.LIVE.delete(livePointerKey(p.slug)); // as if it had not landed
    await approve(p, T0 + 1);
    expect((await env.LIVE.head(livePointerKey(p.slug)))?.customMetadata?.["versionId"]).toBe(p.versionId);
    expect((await auditActions(env.DB, p.siteId)).filter((a) => a === "version.approved")).toHaveLength(1);
  });

  it("a put that rejected on a site that is down takes the pointer out and is site_taken_down", async () => {
    const p = await pendingWithPages(env);
    const down = () => env.DB.prepare("UPDATE sites SET taken_down_at = 40 WHERE id = ?").bind(p.siteId).run().then(() => undefined);
    expect((await failure(approve(p, T0, { ...env, LIVE: landsThenRejects(p.slug, down) }))).code).toBe("site_taken_down");
    expect(await env.LIVE.head(livePointerKey(p.slug))).toBeNull();
  });

  it("a D1 re-read that throws takes the pointer out (best effort) and is live_copy_failed; approving again heals it", async () => {
    const p = await pendingWithPages(env);
    const db = watchDb(env.DB, async ({ method, sql }) => {
      if (method === "first" && sql.startsWith("SELECT taken_down_at FROM sites")) throw new Error("D1 is unavailable");
    });
    const error = await failure(approve(p, T0, { ...env, DB: db }));
    expect(detailOf(error)).toEqual({ code: "live_copy_failed", detail: { versionId: p.versionId } });
    expect(await env.LIVE.head(livePointerKey(p.slug))).toBeNull();
    expect(await siteRow(env.DB, p.siteId)).toMatchObject({ live_version_id: p.versionId });
    await approve(p, T0 + 1);
    expect((await env.LIVE.head(livePointerKey(p.slug)))?.customMetadata?.["versionId"]).toBe(p.versionId);
    expect((await auditActions(env.DB, p.siteId)).filter((a) => a === "version.approved")).toHaveLength(1);
  });

  it("logs pointer_unconfirmed when that delete fails too, and approving again heals it", async () => {
    const p = await pendingWithPages(env);
    const db = watchDb(env.DB, async ({ method, sql }) => {
      if (method === "first" && sql.startsWith("SELECT taken_down_at FROM sites")) throw new Error("D1 is unavailable");
    });
    const noDelete = flakyBucket(env.LIVE, (call) => call === "delete");
    const logged = logs();
    try {
      expect((await failure(approve(p, T0, { ...env, DB: db, LIVE: noDelete }))).code).toBe("live_copy_failed");
      expect(logged.mock.calls.map((c) => String(c[0]))).toContainEqual(JSON.stringify({ code: "pointer_unconfirmed", siteId: p.siteId, versionId: p.versionId }));
    } finally {
      logged.mockRestore();
    }
    await approve(p, T0 + 1);
    expect((await env.LIVE.head(livePointerKey(p.slug)))?.customMetadata?.["versionId"]).toBe(p.versionId);
  });

  it("a rejected put with the re-read taking the pointer out leaves no pointer when the site is down and the delete works; logs when it does not", async () => {
    const p = await pendingWithPages(env);
    const down = () => env.DB.prepare("UPDATE sites SET taken_down_at = 40 WHERE id = ?").bind(p.siteId).run().then(() => undefined);
    const stuck = {
      ...landsThenRejects(p.slug, down),
      delete: () => Promise.reject(new Error("R2 is unavailable")),
    } as unknown as R2Bucket;
    const logged = logs();
    try {
      expect((await failure(approve(p, T0, { ...env, LIVE: stuck }))).code).toBe("site_taken_down");
      expect(logged.mock.calls.map((c) => String(c[0]))).toContainEqual(JSON.stringify({ code: "takedown_pointer_left", siteId: p.siteId, versionId: p.versionId }));
    } finally {
      logged.mockRestore();
    }
  });
});

describe("removeOtherVersions stops when D1 moved on (test 8)", () => {
  /** v1 approved, then v2 approved (its cleanup removed v1's pages), then v1's pages put back as stale objects. */
  async function twoVersions() {
    const v1 = await liveSite();
    const second = await createPendingVersion(env, { siteId: v1.siteId, ownerId: v1.ownerId, slug: v1.slug, document: doc("hvac-phoenix"), edits: EDITS, generationId: null, now: 30 });
    const v2 = { versionId: second.id, htmlSha256: String((await versionRow(env.DB, second.id))?.html_sha256) };
    await approve(v2, 31);
    for (const page of v1.pages) await env.LIVE.put(livePageKey(v1.slug, v1.versionId, page.page), page.html);
    return { v1, v2 };
  }
  const v1Keys = (v1: Built) => v1.pages.map((page) => livePageKey(v1.slug, v1.versionId, page.page)).sort();
  const stored = async (v1: Built) => (await liveKeysOf(env.LIVE, v1.slug)).filter((k) => k.startsWith(`${liveSitePrefix(v1.slug)}${v1.versionId}/`));

  it("deletes the other versions' pages while D1 still names the kept version and the lease is its own", async () => {
    const { v1, v2 } = await twoVersions();
    const token = await acquireLease(env.DB, v1.siteId, T0, "site_not_found");
    await removeOtherVersions(env.LIVE, env.DB, v1.slug, { siteId: v1.siteId, versionId: v2.versionId }, token);
    expect(await stored(v1)).toEqual([]);
  });

  it("stops, logs and never throws when D1 names another version between the listing and the delete: the live version's pages stay", async () => {
    const { v1, v2 } = await twoVersions();
    const token = await acquireLease(env.DB, v1.siteId, T0, "site_not_found");
    const flip = watchBucket(env.LIVE, async (call) => {
      if (call === "list") await env.DB.prepare("UPDATE sites SET live_version_id = ? WHERE id = ?").bind(v1.versionId, v1.siteId).run(); // v1 is live again
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await removeOtherVersions(flip, env.DB, v1.slug, { siteId: v1.siteId, versionId: v2.versionId }, token);
      expect(logged.mock.calls.map((c) => String(c[0]))).toEqual([JSON.stringify({ code: "live_cleanup_skipped", siteId: v1.siteId, versionId: v2.versionId })]);
    } finally {
      logged.mockRestore();
    }
    expect(await stored(v1)).toEqual(v1Keys(v1));
  });

  it("stops when the lease is no longer its own", async () => {
    const { v1, v2 } = await twoVersions();
    const token = await acquireLease(env.DB, v1.siteId, T0, "site_not_found");
    await steal(v1.siteId);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await removeOtherVersions(env.LIVE, env.DB, v1.slug, { siteId: v1.siteId, versionId: v2.versionId }, token);
    } finally {
      logged.mockRestore();
    }
    expect(await stored(v1)).toEqual(v1Keys(v1));
  });
});
