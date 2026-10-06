import { canonicalJson, liveKeyVersionId, livePointerKey, liveSitePrefix, mediaSitePrefix, newId, REDACTED_REASON, workSitePrefix } from "@asksite/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireLease, approveVersion, deleteOwner, releaseLease, takeDown, type DeleteOwnerResult, type OwnerDeletionCounts } from "../src/index.ts";
import { takeDownUnderLease } from "../src/site-state.ts";
import { publishFailure as failure } from "./support/errors.ts";
import { flakyBucket, liveKeysOf, pendingWithPages, publishingHarness, type PublishEnv } from "./support/harness.ts";
import { watchBucket, watchDb } from "./support/lease.ts";
import { ADMIN, addControlSites, DISABLE_REASON, dumpAll, dumpScope, listBucket, listMeta, REPEAT_REASON, seedClosingOwner, TAKEDOWN_REASON, type ClosingOwner } from "./support/owner-seed.ts";

const harness = publishingHarness("publishing-owner-deletion-test");
let env: PublishEnv;
beforeAll(async () => {
  env = await harness.start();
}, 120_000);
afterAll(async () => {
  await harness.server.close();
});

const NOW = 5_000_000;
const T = 180_000; // seeding two owners and dumping every bucket are slow in workerd
const del = (o: ClosingOwner, e: PublishEnv = env, extra: Partial<{ confirmEmail: string; now: number }> = {}) =>
  deleteOwner(e, { ownerId: o.ownerId, confirmEmail: o.email, reviewer: ADMIN, now: NOW, ...extra });

/** A target owner and a control owner of the same shape; the control also holds the prefix neighbour and the claimant of the target's freed old slug. */
async function pair() {
  const target = await seedClosingOwner(env, "target");
  const control = await seedClosingOwner(env, "control");
  const extras = await addControlSites(env, control, target);
  return { target, control, extras };
}

function deletedCounts(result: DeleteOwnerResult): OwnerDeletionCounts {
  if (result.outcome !== "deleted") throw new Error(`expected deleted, got ${result.outcome}`);
  return result.counts;
}

const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())?.n;

/** Both ways to see that the target is gone: no rows by any link, and no object by prefix, pointer, version id or metadata. */
async function expectTargetGone(t: ClosingOwner, versionIds: string[]) {
  const ids = JSON.stringify(t.siteIds);
  const zero = async (sql: string, ...binds: unknown[]) => expect(await count(sql, ...binds), sql).toBe(0);
  await zero("SELECT COUNT(*) AS n FROM owners WHERE id = ? OR email = ?", t.ownerId, t.email);
  await zero("SELECT COUNT(*) AS n FROM sites WHERE owner_id = ? OR id IN (SELECT value FROM json_each(?))", t.ownerId, ids);
  await zero("SELECT COUNT(*) AS n FROM leads WHERE site_id IN (SELECT value FROM json_each(?))", ids);
  await zero("SELECT COUNT(*) AS n FROM uploads WHERE site_id IN (SELECT value FROM json_each(?))", ids);
  await zero("SELECT COUNT(*) AS n FROM site_versions WHERE site_id IN (SELECT value FROM json_each(?))", ids);
  await zero("SELECT COUNT(*) AS n FROM generations WHERE owner_id = ? OR site_id IN (SELECT value FROM json_each(?))", t.ownerId, ids);
  await zero("SELECT COUNT(*) AS n FROM sessions WHERE owner_id = ?", t.ownerId);
  await zero("SELECT COUNT(*) AS n FROM login_tokens WHERE owner_id = ?", t.ownerId);
  await zero("SELECT COUNT(*) AS n FROM invites WHERE owner_id = ? OR email = ? OR site_id IN (SELECT value FROM json_each(?))", t.ownerId, t.email, ids);
  await zero("SELECT COUNT(*) AS n FROM dev_outbox WHERE to_addr = ?", t.email);
  for (const id of t.siteIds) {
    expect(await listBucket(env.WORK, workSitePrefix(id))).toEqual([]);
    expect(await listBucket(env.MEDIA, mediaSitePrefix(id))).toEqual([]);
  }
  expect(await env.LIVE.head(livePointerKey(t.a.slug))).toBeNull();
  expect(await env.LIVE.head(livePointerKey(t.b.slug))).toBeNull();
  expect(await listBucket(env.LIVE, liveSitePrefix(t.a.slug))).toEqual([]);
  expect(await listBucket(env.LIVE, liveSitePrefix(t.b.slug))).toEqual([]);
  expect(await listBucket(env.LIVE, `${t.b.oldSlug}/${t.b.orphanVersionId}/`)).toEqual([]);
  // The second way (an empty listing under a prefix is not proof): every LIVE object, by version id and by metadata.
  for (const object of await listMeta(env.LIVE)) {
    const version = liveKeyVersionId(object.key);
    expect(version === null || !versionIds.includes(version), object.key).toBe(true);
    expect(t.siteIds.includes(object.customMetadata?.["siteId"] ?? ""), object.key).toBe(false);
  }
}

const allVersionIds = (o: ClosingOwner) => [...o.a.versionIds, ...o.b.versionIds];
const lockOf = async (siteId: string) => (await env.DB.prepare("SELECT admin_lock, admin_lock_until FROM sites WHERE id = ?").bind(siteId).first<{ admin_lock: string | null; admin_lock_until: number | null }>());
const auditRows = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(`SELECT * FROM audit_log WHERE ${sql} ORDER BY id`).bind(...binds).all<{ id: number; actor: string; action: string; site_id: string | null; detail_json: string | null }>()).results;
const isBatchOf = (sql: string, needle: string) => sql.includes(needle);

describe("deleteOwner", () => {
  it("deletes every row and object of a disabled owner and keeps the control byte-identical", async () => {
    const { target, control, extras } = await pair();
    const controlBefore = await dumpScope(env, control);
    const claimantPointer = await env.LIVE.head(livePointerKey(extras.claimant));
    expect(claimantPointer).not.toBeNull();
    expect((await listBucket(env.LIVE, `${target.b.oldSlug}/`)).map((o) => o.key)).toContain(target.b.orphanKey); // the orphan sits next to the claimant's pages
    expect((await listBucket(env.LIVE, `${target.b.oldSlug}/`)).length).toBeGreaterThan(1);

    const counts = deletedCounts(await del(target));

    expect(await dumpScope(env, control)).toEqual(controlBefore);
    await expectTargetGone(target, allVersionIds(target));
    // The control's keys under the freed old slug (the claimant's pointer and pages) are still there.
    expect(await env.LIVE.head(livePointerKey(extras.claimant))).not.toBeNull();
    expect((await listBucket(env.LIVE, `${target.b.oldSlug}/`)).map((o) => o.key)).not.toContain(target.b.orphanKey);
    expect((await listBucket(env.LIVE, `${target.b.oldSlug}/`)).length).toBeGreaterThan(0);
    expect(counts.attempts).toBe(1);
  }, T);

  it("keeps every audit row, redacts the two reasons, adds two count-only rows", async () => {
    const { target, control } = await pair();
    const ids = JSON.stringify(target.siteIds);
    const before = await auditRows("1 = 1");
    const controlBefore = await auditRows("site_id IN (SELECT value FROM json_each(?)) OR json_extract(detail_json, '$.ownerId') = ?", JSON.stringify(control.siteIds), control.ownerId);
    const reasons = [TAKEDOWN_REASON, REPEAT_REASON, DISABLE_REASON];
    const mentioning = (needle: string, scopeIds: string, ownerId: string) =>
      count("SELECT COUNT(*) AS n FROM audit_log WHERE (instr(detail_json, ?) > 0 OR instr(actor, ?) > 0) AND (site_id IN (SELECT value FROM json_each(?)) OR json_extract(detail_json, '$.ownerId') = ? OR actor = ?)", needle, needle, scopeIds, ownerId, `owner:${ownerId}`);
    for (const reason of reasons) expect(await mentioning(reason, ids, target.ownerId), reason).toBeGreaterThan(0); // the seed has them

    const counts = deletedCounts(await del(target));

    const after = await auditRows("1 = 1");
    const afterById = new Map(after.map((r) => [r.id, r]));
    for (const row of before) {
      const now = afterById.get(row.id);
      expect(now, `audit row ${row.id} still exists`).toBeDefined();
      const mine = row.site_id !== null && target.siteIds.includes(row.site_id) && row.action === "site.taken_down";
      const disabled = row.action === "owner.disabled" && JSON.parse(String(row.detail_json)).ownerId === target.ownerId;
      if (mine || disabled) {
        expect(JSON.parse(String(now?.detail_json))).toEqual({ ...JSON.parse(String(row.detail_json)), reason: REDACTED_REASON }); // every other key unchanged
        expect({ ...now, detail_json: null }).toEqual({ ...row, detail_json: null });
      } else {
        expect(now).toEqual(row); // every other row byte-identical
      }
    }
    for (const reason of reasons) expect(await mentioning(reason, ids, target.ownerId), reason).toBe(0);
    expect(await mentioning(target.email, ids, target.ownerId)).toBe(0);
    expect(await mentioning("Joe", ids, target.ownerId)).toBe(0);
    // The control's reasons are untouched.
    expect(await auditRows("site_id IN (SELECT value FROM json_each(?)) OR json_extract(detail_json, '$.ownerId') = ?", JSON.stringify(control.siteIds), control.ownerId)).toEqual(controlBefore);

    const added = after.filter((r) => !before.some((b) => b.id === r.id));
    expect(added.map((r) => r.action)).toEqual(["owner.deletion_started", "site.taken_down", "site.taken_down", "owner.deleted"]);
    expect(added.every((r) => r.actor === `admin:${ADMIN}`)).toBe(true);
    expect(added[0]?.site_id).toBeNull();
    expect(added[0]?.detail_json).toBe(canonicalJson({ ownerId: target.ownerId, siteIds: target.siteIds }));
    for (const takedown of added.slice(1, 3)) expect(JSON.parse(String(takedown.detail_json))).toEqual({ purgeMedia: true, reason: REDACTED_REASON });
    expect(added[3]?.site_id).toBeNull();
    expect(added[3]?.detail_json).toBe(canonicalJson({ ownerId: target.ownerId, ...counts }));
    const e = target.expected;
    expect(counts).toEqual({
      attempts: 1,
      siteIds: target.siteIds,
      rows: { sites: e.sites, site_versions: e.site_versions, generations: e.generations, uploads: e.uploads, leads: e.leads, invites: e.invites, sessions: e.sessions, login_tokens: e.login_tokens, dev_outbox: e.dev_outbox, owners: 1 },
      objects: { work: e.work, live: e.live, media: e.media },
      auditRedacted: 3, // the seed's takedown row, its repeat row and the disable row; the deletion's own takedown rows are written redacted
    });
  }, T);

  it("returns { outcome: 'deleted', counts } equal to the owner.deleted row, attempts 1", async () => {
    const { target } = await pair();
    const result = await del(target);
    expect(result).toEqual({ outcome: "deleted", counts: expect.objectContaining({ attempts: 1 }) });
    const rows = await auditRows("action = 'owner.deleted' AND json_extract(detail_json, '$.ownerId') = ?", target.ownerId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0]?.detail_json))).toEqual({ ownerId: target.ownerId, ...deletedCounts(result) });
  }, T);

  it("frees the slugs: another site can take the deleted site's address", async () => {
    const { target, control, extras } = await pair();
    await del(target);
    const neighbour = (await env.DB.prepare("SELECT id FROM sites WHERE slug = ?").bind(extras.neighbour).first<{ id: string }>())?.id;
    const changed = await env.DB.prepare("UPDATE sites SET slug = ? WHERE id = ?").bind(target.a.slug, neighbour).run();
    expect(changed.meta.changes).toBe(1);
    const other = control.siteIds.find((id) => id !== neighbour) ?? "";
    expect((await env.DB.prepare("UPDATE sites SET slug = ? WHERE id = ?").bind(target.b.slug, other).run()).meta.changes).toBe(1);
  }, T);

  it("accepts the email with other case and spaces", async () => {
    const { target } = await pair();
    expect((await del(target, env, { confirmEmail: `  ${target.email.toUpperCase()} ` })).outcome).toBe("deleted");
  }, T);
});

describe("deleteOwner refusals change nothing and leave no lease", () => {
  it("not disabled", async () => {
    const { target } = await pair();
    await env.DB.prepare("UPDATE owners SET disabled_at = NULL WHERE id = ?").bind(target.ownerId).run();
    const before = await dumpAll(env);
    expect(await del(target)).toEqual({ outcome: "not_disabled" });
    expect(await dumpAll(env)).toEqual(before);
  }, T);

  it("wrong email", async () => {
    const { target } = await pair();
    const before = await dumpAll(env);
    for (const confirmEmail of ["someone@example.com", target.email.replace("@", "x@"), `${target.email}.`, " "]) {
      expect(await del(target, env, { confirmEmail })).toEqual({ outcome: "email_mismatch" });
    }
    expect(await dumpAll(env)).toEqual(before);
  }, T);

  it("unknown id", async () => {
    await pair();
    const before = await dumpAll(env);
    expect(await deleteOwner(env, { ownerId: newId(), confirmEmail: "x@example.com", reviewer: ADMIN, now: NOW })).toEqual({ outcome: "not_found" });
    expect(await deleteOwner(env, { ownerId: "not-an-id", confirmEmail: "x@example.com", reviewer: ADMIN, now: NOW })).toEqual({ outcome: "not_found" });
    expect(await dumpAll(env)).toEqual(before);
  }, T);

  it("a site held by another action: site_busy with retryAfter, the other leases released, nothing written", async () => {
    const { target } = await pair();
    const [first, held] = target.siteIds as [string, string]; // leases go in id order: the first is taken, then the held one refuses
    await env.DB.prepare("UPDATE sites SET admin_lock = 'someone-else', admin_lock_until = ? WHERE id = ?").bind(NOW + 60_000, held).run();
    const before = await dumpAll(env);
    const error = await failure(del(target));
    expect(error.code).toBe("site_busy");
    expect(error.detail).toEqual({ retryAfter: 60 });
    expect(await lockOf(first)).toEqual({ admin_lock: null, admin_lock_until: null });
    expect((await lockOf(held))?.admin_lock).toBe("someone-else");
    expect(await dumpAll(env)).toEqual(before); // no deletion_started row, nothing else
    expect(await auditRows("action = 'owner.deletion_started' AND json_extract(detail_json, '$.ownerId') = ?", target.ownerId)).toEqual([]);
  }, T);
});

describe("deleteOwner crash and retry", () => {
  /** The failing run throws; the owner and both sites are still there with no lease held; a clean second call finishes it exactly as a first run would. */
  async function failsThenFinishes(failing: (t: ClosingOwner) => Promise<PublishEnv>, opts: { down?: boolean } = {}) {
    const { target, control } = await pair();
    const controlBefore = await dumpScope(env, control);
    const failingEnv = await failing(target);
    await expect(del(target, failingEnv)).rejects.toThrow();
    expect(await count("SELECT COUNT(*) AS n FROM owners WHERE id = ?", target.ownerId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM sites WHERE owner_id = ?", target.ownerId)).toBe(2);
    if (opts.down !== false) expect(await count("SELECT COUNT(*) AS n FROM sites WHERE owner_id = ? AND taken_down_at IS NOT NULL", target.ownerId)).toBe(2);
    for (const id of target.siteIds) expect(await lockOf(id)).toEqual({ admin_lock: null, admin_lock_until: null });
    const counts = deletedCounts(await del(target, env, { now: NOW + 1000 }));
    await expectTargetGone(target, allVersionIds(target));
    expect(await dumpScope(env, control)).toEqual(controlBefore);
    expect(await auditRows("action = 'owner.deletion_started' AND json_extract(detail_json, '$.ownerId') = ?", target.ownerId)).toHaveLength(2);
    const deletedRows = await auditRows("action = 'owner.deleted' AND json_extract(detail_json, '$.ownerId') = ?", target.ownerId);
    expect(deletedRows).toHaveLength(1);
    expect(JSON.parse(String(deletedRows[0]?.detail_json)).attempts).toBe(2);
    expect(counts.attempts).toBe(2);
    return { target, counts };
  }

  it("an R2 delete fails part-way (the second site's WORK prefix)", async () => {
    await failsThenFinishes(async (t) => {
      const second = t.siteIds[1] ?? "";
      return { ...env, WORK: flakyBucket(env.WORK, (call, arg) => call === "delete" && Array.isArray(arg) && arg.some((k) => String(k).startsWith(workSitePrefix(second)))) };
    });
  }, T);

  it("the LIVE sweep fails", async () => {
    await failsThenFinishes(async () => ({ ...env, LIVE: flakyBucket(env.LIVE, (call, arg) => call === "list" && (arg as R2ListOptions | undefined)?.prefix === "") }));
  }, T);

  it("the bulk batch of the second site throws after the first site's committed", async () => {
    const { target, control } = await pair();
    const controlBefore = await dumpScope(env, control);
    const [first, second] = target.siteIds as [string, string];
    let seen = 0;
    const db = watchDb(env.DB, async ({ sql, method }) => {
      if (method === "batch" && isBatchOf(sql, "DELETE FROM leads") && ++seen === 2) throw new Error("D1 is unavailable");
    });
    await expect(del(target, { ...env, DB: db })).rejects.toThrow("D1 is unavailable");
    // The first site's bulk rows are gone and its sites row is still there; the second site is untouched but down.
    expect(await count("SELECT COUNT(*) AS n FROM leads WHERE site_id = ?", first)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM site_versions WHERE site_id = ?", first)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM sites WHERE id = ?", first)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM leads WHERE site_id = ?", second)).toBe(3);
    expect(await count("SELECT COUNT(*) AS n FROM sites WHERE owner_id = ? AND taken_down_at IS NOT NULL", target.ownerId)).toBe(2);
    for (const id of target.siteIds) expect(await lockOf(id)).toEqual({ admin_lock: null, admin_lock_until: null });
    const counts = deletedCounts(await del(target, env, { now: NOW + 1000 }));
    expect(counts.attempts).toBe(2);
    expect(counts.rows.leads).toBe(3); // this run's counts: the first site's rows went in the failed run
    await expectTargetGone(target, allVersionIds(target));
    expect(await dumpScope(env, control)).toEqual(controlBefore);
  }, T);

  it("a crash right after owner.deletion_started", async () => {
    await failsThenFinishes(
      async () => ({
        ...env,
        DB: watchDb(env.DB, async () => {}, async ({ sql, method }) => {
          if (method === "run" && sql.includes("'owner.deletion_started'")) throw new Error("D1 timed out");
        }),
      }),
      { down: false },
    );
  }, T);

  it("the final batch throws before it commits: nothing of it committed", async () => {
    await failsThenFinishes(async () => ({
      ...env,
      DB: watchDb(env.DB, async ({ sql, method }) => {
        if (method === "batch" && sql.includes("DELETE FROM owners")) throw new Error("D1 is unavailable");
      }),
    }));
  }, T);

  it("the final batch commits and then throws: the same call returns deleted, and the next one already_deleted", async () => {
    const { target, control } = await pair();
    const controlBefore = await dumpScope(env, control);
    const db = watchDb(env.DB, async () => {}, async ({ sql, method }) => {
      if (method === "batch" && sql.includes("DELETE FROM owners")) throw new Error("D1 timed out after commit");
    });
    const result = await del(target, { ...env, DB: db });
    const counts = deletedCounts(result);
    await expectTargetGone(target, allVersionIds(target));
    const rows = await auditRows("action = 'owner.deleted' AND json_extract(detail_json, '$.ownerId') = ?", target.ownerId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0]?.detail_json))).toEqual({ ownerId: target.ownerId, ...counts });
    expect(await del(target)).toEqual({ outcome: "already_deleted" });
    expect(await dumpScope(env, control)).toEqual(controlBefore);
  }, T);
});

describe("deleteOwner under a lost lease or an owner enabled again", () => {
  it("a lease stolen before the final batch: site_busy lease_lost, the batch rolled back, a retry finishes", async () => {
    const { target, control } = await pair();
    const controlBefore = await dumpScope(env, control);
    const [first] = target.siteIds as [string, string];
    let stolen = false;
    const db = watchDb(env.DB, async ({ sql, method }) => {
      if (method === "batch" && sql.includes("DELETE FROM owners") && !stolen) {
        stolen = true;
        await env.DB.prepare("UPDATE sites SET admin_lock = 'thief', admin_lock_until = 9000000000000 WHERE id = ?").bind(first).run();
      }
    });
    const error = await failure(del(target, { ...env, DB: db }));
    expect({ code: error.code, detail: error.detail }).toEqual({ code: "site_busy", detail: { reason: "lease_lost" } });
    expect(await count("SELECT COUNT(*) AS n FROM owners WHERE id = ?", target.ownerId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM sites WHERE owner_id = ?", target.ownerId)).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'owner.deleted' AND json_extract(detail_json, '$.ownerId') = ?", target.ownerId)).toBe(0);
    expect((await lockOf(first))?.admin_lock).toBe("thief");
    await env.DB.prepare("UPDATE sites SET admin_lock = NULL, admin_lock_until = NULL WHERE id = ?").bind(first).run();
    deletedCounts(await del(target, env, { now: NOW + 1000 }));
    await expectTargetGone(target, allVersionIds(target));
    expect(await dumpScope(env, control)).toEqual(controlBefore);
  }, T);

  it("an owner enabled again mid-run: not_disabled, the owner and sites stay, no owner.deleted row", async () => {
    const { target, control } = await pair();
    const controlBefore = await dumpScope(env, control);
    const db = watchDb(env.DB, async ({ sql, method }) => {
      if (method === "batch" && sql.includes("DELETE FROM owners")) await env.DB.prepare("UPDATE owners SET disabled_at = NULL WHERE id = ?").bind(target.ownerId).run();
    });
    expect(await del(target, { ...env, DB: db })).toEqual({ outcome: "not_disabled" });
    expect(await count("SELECT COUNT(*) AS n FROM owners WHERE id = ?", target.ownerId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM sites WHERE owner_id = ?", target.ownerId)).toBe(2);
    // Nothing of the final batch ran: the sites rows keep their children that the final batch would have deleted.
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE owner_id = ?", target.ownerId)).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM invites WHERE email = ?", target.email)).toBe(2); // the accepted one (bound to a site) went with its site's bulk rows
    expect(await count("SELECT COUNT(*) AS n FROM dev_outbox WHERE to_addr = ?", target.email)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'owner.deleted' AND json_extract(detail_json, '$.ownerId') = ?", target.ownerId)).toBe(0);
    for (const id of target.siteIds) expect(await lockOf(id)).toEqual({ admin_lock: null, admin_lock_until: null });
    expect(await dumpScope(env, control)).toEqual(controlBefore);
  }, T);

  it("a second run after a finished deletion is a no-op: already_deleted, nothing written, no R2 call", async () => {
    const { target } = await pair();
    await del(target);
    const before = await dumpAll(env);
    const calls: Array<{ call: string; arg: unknown }> = [];
    const watched = { ...env, WORK: watchBucket(env.WORK, undefined, calls), LIVE: watchBucket(env.LIVE, undefined, calls), MEDIA: watchBucket(env.MEDIA, undefined, calls) };
    expect(await del(target, watched)).toEqual({ outcome: "already_deleted" });
    expect(await dumpAll(env)).toEqual(before);
    expect(calls).toEqual([]);
  }, T);
});

describe("deleteOwner R2 paging and leftovers", () => {
  it("deletes in calls of at most 1,000 keys across every listing page, and keeps 1,000+ unrelated LIVE objects", async () => {
    const { target } = await pair();
    const stale = Array.from({ length: 1001 }, () => `${workSitePrefix(target.a.siteId)}${newId()}/home.html`);
    const unrelated = Array.from({ length: 1001 }, (_, i) => `aaa-paging-${i}/${newId()}/home.html`); // sort before the orphan
    for (let i = 0; i < stale.length; i += 100) await Promise.all(stale.slice(i, i + 100).map((key) => env.WORK.put(key, "old")));
    for (let i = 0; i < unrelated.length; i += 100) await Promise.all(unrelated.slice(i, i + 100).map((key) => env.LIVE.put(key, "keep")));
    const calls: Array<{ call: string; arg: unknown }> = [];
    const flaky = { ...env, WORK: flakyBucket(env.WORK, () => false, calls), LIVE: flakyBucket(env.LIVE, () => false, calls) };

    const counts = deletedCounts(await del(target, flaky));

    const deleted = calls.filter((c) => c.call === "delete").map((c) => c.arg as string[]);
    expect(deleted.every((keys) => keys.length <= 1000)).toBe(true);
    expect(counts.objects.work).toBe(target.expected.work + 1001);
    expect(deleted.flat().filter((k) => k.startsWith("versions/"))).toHaveLength(target.expected.work + 1001);
    await expectTargetGone(target, allVersionIds(target));
    const kept = (await listMeta(env.LIVE, "aaa-paging-")).map((o) => o.key);
    for (let i = 0; i < kept.length; i += 500) await env.LIVE.delete(kept.slice(i, i + 500)); // so later tests list a small bucket
    expect(kept.sort()).toEqual(unrelated.sort());
  }, T);

  it("a site id only an earlier owner.deletion_started row names: its WORK and MEDIA prefixes are emptied, nothing else is touched", async () => {
    const { target, control } = await pair();
    const controlBefore = await dumpScope(env, control);
    const x = newId();
    await env.DB.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (30, ?, 'owner.deletion_started', NULL, ?)").bind(`admin:${ADMIN}`, canonicalJson({ ownerId: target.ownerId, siteIds: [x] })).run();
    await env.WORK.put(`versions/${x}/${newId()}.html`, "w");
    await env.MEDIA.put(`${x}/${newId()}.webp`, "m");
    const unrelated = newId();
    await env.WORK.put(`versions/${unrelated}/${newId()}.html`, "other site");

    const counts = deletedCounts(await del(target));

    expect(await listBucket(env.WORK, workSitePrefix(x))).toEqual([]);
    expect(await listBucket(env.MEDIA, mediaSitePrefix(x))).toEqual([]);
    expect(await listBucket(env.WORK, workSitePrefix(unrelated))).toHaveLength(1);
    expect(counts.siteIds).toEqual([...target.siteIds, x].sort());
    expect(counts.attempts).toBe(2);
    expect(counts.objects.work).toBe(target.expected.work + 1);
    expect(counts.objects.media).toBe(target.expected.media + 1);
    expect(await dumpScope(env, control)).toEqual(controlBefore);
  }, T);
});

describe("takeDownUnderLease", () => {
  it("returns the LIVE page objects and MEDIA objects it deleted, and takeDown still resolves to undefined", async () => {
    const p = await pendingWithPages(env);
    await approveVersion(env, { versionId: p.versionId, htmlSha256: p.htmlSha256, reviewer: ADMIN, note: null, indexable: true, now: 20 });
    const photos = [newId(), newId()];
    await Promise.all(photos.map((id) => env.MEDIA.put(`${p.siteId}/${id}.webp`, "photo")));
    const token = await acquireLease(env.DB, p.siteId, 30, "site_not_found");
    try {
      expect(await takeDownUnderLease(env, { siteId: p.siteId, reviewer: ADMIN, reason: "r", purgeMedia: true, now: 30, token })).toEqual({ live: 3, media: 2 });
      expect(await takeDownUnderLease(env, { siteId: p.siteId, reviewer: ADMIN, reason: "r", purgeMedia: true, now: 30, token })).toEqual({ live: 0, media: 0 });
    } finally {
      await releaseLease(env.DB, p.siteId, token);
    }
    expect(await liveKeysOf(env.LIVE, p.slug)).toEqual([]);

    const q = await pendingWithPages(env);
    await approveVersion(env, { versionId: q.versionId, htmlSha256: q.htmlSha256, reviewer: ADMIN, note: null, indexable: true, now: 20 });
    expect(await takeDown(env, { siteId: q.siteId, reviewer: ADMIN, reason: "r", purgeMedia: true, now: 31 })).toBeUndefined();
  }, T);
});
