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
      const hasReason = row.detail_json !== null && JSON.parse(row.detail_json).reason !== undefined;
      if ((mine || disabled) && hasReason) {
        expect(JSON.parse(String(now?.detail_json))).toEqual({ ...JSON.parse(String(row.detail_json)), reason: REDACTED_REASON }); // every other key unchanged
        expect({ ...now, detail_json: null }).toEqual({ ...row, detail_json: null });
      } else {
        expect(now).toEqual(row); // every other row byte-identical, and a row with no reason gets none (json_replace, not json_set)
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

  /** Every D1 write: a refusal in Phase 0 must make none (no lease, no row). */
  const writesOf = (log: string[]) =>
    watchDb(env.DB, async ({ sql, method }) => {
      if (method === "batch" || (method === "run" && !sql.trimStart().startsWith("SELECT"))) log.push(sql);
    });

  // Ported from review R1 (finding I-1, mutant 10 "Phase 0 disabled check removed"): without the check the email answer
  // comes first and Phase 1 writes leases on the sites of an owner who is not closing.
  it("an enabled owner with a wrong email is not_disabled (not email_mismatch), and nothing is written", async () => {
    const t = await seedClosingOwner(env, "enabled-wrong-email");
    await env.DB.prepare("UPDATE owners SET disabled_at = NULL WHERE id = ?").bind(t.ownerId).run();
    const writes: string[] = [];
    expect(await del(t, { ...env, DB: writesOf(writes) }, { confirmEmail: "someone@example.com" })).toEqual({ outcome: "not_disabled" });
    expect(writes).toEqual([]);
  }, T);

  // Ported from review R2 (I-1): an enabled owner's busy site must not turn the answer into site_busy, and the holder's lock stays.
  it("an enabled owner whose site another action holds is not_disabled (not site_busy), the holder's lock untouched, nothing written", async () => {
    const t = await seedClosingOwner(env, "enabled-held");
    await env.DB.prepare("UPDATE owners SET disabled_at = NULL WHERE id = ?").bind(t.ownerId).run();
    const held = t.siteIds[0] ?? "";
    await env.DB.prepare("UPDATE sites SET admin_lock = 'someone-else', admin_lock_until = ? WHERE id = ?").bind(NOW + 60_000, held).run();
    const writes: string[] = [];
    expect(await del(t, { ...env, DB: writesOf(writes) })).toEqual({ outcome: "not_disabled" });
    expect((await lockOf(held))?.admin_lock).toBe("someone-else");
    expect(writes).toEqual([]);
    await env.DB.prepare("UPDATE sites SET admin_lock = NULL, admin_lock_until = NULL WHERE id = ?").bind(held).run();
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
    // pin changed: old (not asserted; the redaction ran before batch F, so a re-enabled owner's reasons were redacted)
    // -> new: the redaction is part of the fenced final batch, so an owner who stays keeps the admin's own words.
    for (const reason of [TAKEDOWN_REASON, REPEAT_REASON, DISABLE_REASON]) expect(await mentionsOf(target, reason), reason).toBeGreaterThan(0);
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

const insertLead = (siteId: string) =>
  env.DB.prepare("INSERT INTO leads (id, site_id, created_at, name, phone, email_status, ip_hash) VALUES (?, ?, 9, 'Late', '+15125550100', 'pending', 'x')").bind(newId(), siteId).run();
const isFinalBatch = (call: { sql: string; method: string }) => call.method === "batch" && call.sql.includes("DELETE FROM owners");
/** Audit rows of this owner (its sites' rows and rows naming its id) that mention `needle` in their detail. */
const mentionsOf = (t: ClosingOwner, needle: string) =>
  count("SELECT COUNT(*) AS n FROM audit_log WHERE instr(detail_json, ?) > 0 AND (site_id IN (SELECT value FROM json_each(?)) OR json_extract(detail_json, '$.ownerId') = ?)", needle, JSON.stringify(t.siteIds), t.ownerId);

describe("deleteOwner fences and stragglers (review round)", () => {
  // Ported from review R3 (finding m-1): G1 is defence in depth for a row the app never writes but the schema allows.
  it("deletes a generation of the owner that sits on another owner's site (G1), not an FK failure", async () => {
    const t = await seedClosingOwner(env, "g1-target");
    const c = await seedClosingOwner(env, "g1-control");
    await env.DB.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at) VALUES (?, ?, ?, 'first', 'failed', '{}', 3)").bind(newId(), c.a.siteId, t.ownerId).run();
    expect((await del(t)).outcome).toBe("deleted");
    expect(await count("SELECT COUNT(*) AS n FROM generations WHERE owner_id = ?", t.ownerId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM generations WHERE owner_id = ?", c.ownerId)).toBe(c.expected.generations); // the control's own are untouched
  }, T);

  // Ported from review R4 (finding I-2): the check right after the LIVE sweep. Without it Phase 3c runs under a lost lease
  // and deletes the other site's version rows, after which no retry can find the version id of an orphan under an old slug.
  it("a lease lost during the LIVE sweep: lease_lost before any bulk row goes, and a retry still finds the orphan", async () => {
    const t = await seedClosingOwner(env, "sweep-lease");
    let stolen = false;
    const db = watchDb(env.DB, async ({ sql, method }) => {
      if (!stolen && method === "all" && sql.startsWith("SELECT id, admin_lock FROM sites WHERE owner_id")) {
        stolen = true;
        await env.DB.prepare("UPDATE sites SET admin_lock = 'thief', admin_lock_until = 9000000000000 WHERE id = ?").bind(t.a.siteId).run();
      }
    });
    const error = await failure(del(t, { ...env, DB: db }));
    expect({ code: error.code, detail: error.detail }).toEqual({ code: "site_busy", detail: { reason: "lease_lost" } });
    expect(stolen).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM site_versions WHERE site_id = ?", t.b.siteId)).toBe(1); // b's bulk rows untouched
    await env.DB.prepare("UPDATE sites SET admin_lock = NULL, admin_lock_until = NULL WHERE id = ?").bind(t.a.siteId).run();
    expect((await del(t, env, { now: NOW + 1000 })).outcome).toBe("deleted");
    await expectTargetGone(t, allVersionIds(t));
  }, T);

  // Finding m-7: the sweep's own per-page lease check. Without it the check after the sweep still throws lease_lost, but the
  // sweep has already deleted this owner's version keys under a lease it no longer holds.
  it("a lease lost at the sweep's first page: the sweep deletes nothing", async () => {
    const t = await seedClosingOwner(env, "sweep-page-lease");
    let stolen = false;
    const swept: string[] = [];
    const db = watchDb(env.DB, async ({ sql, method }) => {
      if (!stolen && method === "all" && sql.startsWith("SELECT id, admin_lock FROM sites WHERE owner_id")) {
        stolen = true;
        await env.DB.prepare("UPDATE sites SET admin_lock = 'thief', admin_lock_until = 9000000000000 WHERE id = ?").bind(t.a.siteId).run();
      }
    });
    // Every LIVE delete, whenever it comes: without the per-page check the sweep's first lease read is the one after it, so
    // "deletes since the theft" would stay empty for the mutant too.
    const live = watchBucket(env.LIVE, async (call, arg) => {
      if (call === "delete") swept.push(...(Array.isArray(arg) ? (arg as string[]) : [String(arg)]));
    });
    expect((await failure(del(t, { ...env, DB: db, LIVE: live }))).code).toBe("site_busy");
    expect(stolen).toBe(true);
    expect(swept).not.toContain(t.b.orphanKey); // the sweep's own delete: a version of this owner under an old slug
    expect(await env.LIVE.head(t.b.orphanKey)).not.toBeNull();
    await env.DB.prepare("UPDATE sites SET admin_lock = NULL, admin_lock_until = NULL WHERE id = ?").bind(t.a.siteId).run();
  }, T);

  // Ported from review R8 (finding I-3): OWNER_CLOSING on the intent row, the only guard for the window before the row exists.
  it("an owner enabled between Phase 0 and the intent row: not_disabled, no site taken down, the pointer and pages stay", async () => {
    const t = await seedClosingOwner(env, "intent-fence");
    const pagesBefore = (await listBucket(env.LIVE, liveSitePrefix(t.a.slug))).length;
    expect(pagesBefore).toBeGreaterThan(0);
    let enabled = false;
    const db = watchDb(env.DB, async ({ sql, method }) => {
      if (!enabled && method === "run" && sql.includes("'owner.deletion_started'")) {
        enabled = true;
        await env.DB.prepare("UPDATE owners SET disabled_at = NULL WHERE id = ?").bind(t.ownerId).run();
      }
    });
    expect(await del(t, { ...env, DB: db })).toEqual({ outcome: "not_disabled" });
    expect(enabled).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM sites WHERE owner_id = ? AND taken_down_at IS NOT NULL", t.ownerId)).toBe(0);
    expect(await env.LIVE.head(livePointerKey(t.a.slug))).not.toBeNull();
    expect((await listBucket(env.LIVE, liveSitePrefix(t.a.slug))).length).toBe(pagesBefore);
    expect(await auditRows("action = 'owner.deletion_started' AND json_extract(detail_json, '$.ownerId') = ?", t.ownerId)).toEqual([]);
  }, T);

  // Ported from review R6 (finding m-3): OWNER_CLOSING on batch C (batch F's fence is tested apart, by the enabled-again test).
  it("an owner enabled right before the bulk batches: not_disabled, every bulk row stays, the reasons are not redacted", async () => {
    const t = await seedClosingOwner(env, "batch-c-fence");
    let enabled = false;
    const db = watchDb(env.DB, async ({ sql, method }) => {
      if (!enabled && method === "batch" && sql.includes("DELETE FROM leads")) {
        enabled = true;
        await env.DB.prepare("UPDATE owners SET disabled_at = NULL WHERE id = ?").bind(t.ownerId).run();
      }
    });
    expect(await del(t, { ...env, DB: db })).toEqual({ outcome: "not_disabled" });
    expect(enabled).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM leads WHERE site_id IN (?, ?)", t.a.siteId, t.b.siteId)).toBe(6);
    expect(await count("SELECT COUNT(*) AS n FROM site_versions WHERE site_id IN (?, ?)", t.a.siteId, t.b.siteId)).toBe(4);
    expect(await mentionsOf(t, DISABLE_REASON)).toBeGreaterThan(0);
  }, T);

  // Ported from review R5, widened (finding m-2): a row of EACH child table that lands after the bulk batches and before
  // batch F, so each of F1-F5 is the only thing that deletes its row (the invite has another email, the generation another
  // owner: neither is reached by the owner-level deletes).
  it("batch F deletes a leads, uploads, versions, invites and generations row that lands after the bulk batches", async () => {
    const t = await seedClosingOwner(env, "stragglers");
    const other = await seedClosingOwner(env, "stragglers-other");
    let planted = false;
    const db = watchDb(env.DB, async (call) => {
      if (planted || !isFinalBatch(call)) return;
      planted = true;
      const site = t.a.siteId;
      await insertLead(site);
      await env.DB.prepare("INSERT INTO uploads (id, site_id, width, height, bytes, created_at) VALUES (?, ?, 1, 1, 1, 9)").bind(newId(), site).run();
      await env.DB.prepare(
        "INSERT INTO site_versions (id, site_id, number, status, document_json, document_sha256, edits_json, html_key, html_sha256, stylesheet_sha256, requested_by, requested_at) VALUES (?, ?, 99, 'rejected', '{}', 'x', '{}', 'k', 'x', 'x', ?, 9)",
      ).bind(newId(), site, t.ownerId).run();
      await env.DB.prepare("INSERT INTO invites (id, token_hash, email, created_by, created_at, expires_at, site_id) VALUES (?, ?, 'stranger@example.net', ?, 9, 9000000000000, ?)").bind(newId(), newId(), ADMIN, site).run();
      await env.DB.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at) VALUES (?, ?, ?, 'first', 'failed', '{}', 9)").bind(newId(), site, other.ownerId).run();
    });
    expect((await del(t, { ...env, DB: db })).outcome).toBe("deleted");
    expect(planted).toBe(true);
    await expectTargetGone(t, allVersionIds(t));
    expect(await count("SELECT COUNT(*) AS n FROM invites WHERE email = 'stranger@example.net'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM generations WHERE site_id = ?", t.a.siteId)).toBe(0);
  }, T);

  // Ported from the re-review (RR3, Minor 1): an owner with no site at all. The redaction is one statement of batch F, so it
  // runs once whatever the number of sites; emitted per site it would never run here and the disable reason would stay.
  it("deletes an owner that has no site, and redacts its owner.disabled reason", async () => {
    const lone = newId();
    const email = `lone-${lone}@example.com`;
    await env.DB.prepare("INSERT INTO owners (id, email, created_at, disabled_at) VALUES (?, ?, 1, 2)").bind(lone, email).run();
    await env.DB.prepare("INSERT INTO sessions (id_hash, owner_id, created_at, expires_at, last_seen_at) VALUES (?, ?, 1, 2, 1)").bind(newId(), lone).run();
    await env.DB.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (24, ?, 'owner.disabled', NULL, ?)").bind(`admin:${ADMIN}`, JSON.stringify({ ownerId: lone, reason: "Lone closure note" })).run();
    const result = await deleteOwner(env, { ownerId: lone, confirmEmail: email, reviewer: ADMIN, now: NOW });
    expect(deletedCounts(result).auditRedacted).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM owners WHERE id = ?", lone)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE owner_id = ?", lone)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE instr(detail_json, 'Lone closure note') > 0")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'owner.deleted' AND json_extract(detail_json, '$.ownerId') = ?", lone)).toBe(1);
  }, T);

  // Ported from the re-review (RR6, Minor 6): batch F's redaction names every site id the run knows (allSiteIds), also one only
  // an earlier owner.deletion_started row names and whose sites row is gone, not just the sites present now.
  it("redacts a site.taken_down reason of a site only an earlier owner.deletion_started row names", async () => {
    const t = await seedClosingOwner(env, "gone-site-reason");
    const x = newId();
    await env.DB.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (30, ?, 'owner.deletion_started', NULL, ?)").bind(`admin:${ADMIN}`, canonicalJson({ ownerId: t.ownerId, siteIds: [x] })).run();
    await env.DB.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (31, ?, 'site.taken_down', ?, ?)").bind(`admin:${ADMIN}`, x, JSON.stringify({ reason: "Gone-site note about Joe", purgeMedia: false })).run();
    const counts = deletedCounts(await del(t));
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE site_id = ? AND instr(detail_json, 'Gone-site note') > 0", x)).toBe(0);
    expect(counts.auditRedacted).toBe(4);
  }, T);

  // Ported from review R5b (finding m-5, ACCEPTED and documented at the counts in owner-deletion.ts): the counts are taken
  // just before the final transaction, so a row that arrives in between is deleted but not counted.
  it("a lead that lands between the counts and the final batch is deleted but not counted", async () => {
    const t = await seedClosingOwner(env, "late-lead");
    let planted = false;
    const db = watchDb(env.DB, async (call) => {
      if (planted || !isFinalBatch(call)) return;
      planted = true;
      await insertLead(t.a.siteId);
    });
    const counts = deletedCounts(await del(t, { ...env, DB: db }));
    expect(planted).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM leads WHERE site_id IN (?, ?)", t.a.siteId, t.b.siteId)).toBe(0);
    expect(counts.rows.leads).toBe(t.expected.leads); // 6 seeded: the late one is not counted
  }, T);

  // Finding m-4: the redaction is part of batch F. A reason written after the old redaction point is still redacted.
  it("redacts an owner.disabled and a site.taken_down reason written just before the final batch", async () => {
    const t = await seedClosingOwner(env, "late-reason");
    let planted = false;
    const db = watchDb(env.DB, async (call) => {
      if (planted || !isFinalBatch(call)) return;
      planted = true;
      await env.DB.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (30, ?, 'owner.disabled', NULL, ?)").bind(`admin:${ADMIN}`, JSON.stringify({ ownerId: t.ownerId, reason: "Late note about Joe" })).run();
      await env.DB.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (30, ?, 'site.taken_down', ?, ?)").bind(`admin:${ADMIN}`, t.a.siteId, JSON.stringify({ reason: "Late takedown note about Joe", purgeMedia: false })).run();
    });
    const counts = deletedCounts(await del(t, { ...env, DB: db }));
    expect(planted).toBe(true);
    expect(await mentionsOf(t, "Late")).toBe(0);
    expect(await mentionsOf(t, "Joe")).toBe(0);
    const late = (await auditRows("at = 30")).filter((r) => r.site_id === t.a.siteId || String(r.detail_json).includes(t.ownerId));
    expect(late).toHaveLength(2);
    for (const row of late) expect(JSON.parse(String(row.detail_json)).reason).toBe(REDACTED_REASON);
    expect(counts.auditRedacted).toBe(3); // the two late rows are redacted but, like a late lead, not counted
  }, T);

  it("redacts nothing when the final batch throws before it commits (the redaction is part of the batch)", async () => {
    const t = await seedClosingOwner(env, "reason-atomic");
    const db = watchDb(env.DB, async (call) => {
      if (isFinalBatch(call)) throw new Error("D1 is unavailable");
    });
    await expect(del(t, { ...env, DB: db })).rejects.toThrow("D1 is unavailable");
    for (const reason of [TAKEDOWN_REASON, REPEAT_REASON, DISABLE_REASON]) expect(await mentionsOf(t, reason), reason).toBeGreaterThan(0);
  }, T);

  // Finding m-6: when D1 commits the batch, throws, and the check afterwards also throws, the batch's error is the one that surfaces.
  it("keeps the final batch's own error when the check after it throws too", async () => {
    const t = await seedClosingOwner(env, "check-throws");
    let committed = false;
    const db = watchDb(
      env.DB,
      async ({ sql, method }) => {
        if (committed && method === "first" && sql.includes("action = 'owner.deleted'")) throw new Error("the check failed");
      },
      async (call) => {
        if (!isFinalBatch(call)) return;
        committed = true;
        throw new Error("D1 timed out after commit");
      },
    );
    await expect(del(t, { ...env, DB: db })).rejects.toThrow("D1 timed out after commit");
    expect(committed).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM owners WHERE id = ?", t.ownerId)).toBe(0); // it did commit
  }, T);

  // Ported from the re-review (RR5, Minor 2): the owner read after a failed final batch is inside the try, so its own failure
  // cannot replace the batch's error.
  it("keeps the final batch's own error when reading the owner afterwards throws", async () => {
    const t = await seedClosingOwner(env, "owner-read-throws");
    let failed = false;
    const db = watchDb(env.DB, async (call) => {
      if (isFinalBatch(call)) {
        failed = true;
        throw new Error("D1 is unavailable");
      }
      if (failed && call.method === "first" && call.sql.startsWith("SELECT id, email, disabled_at FROM owners")) throw new Error("the owner read failed");
    });
    await expect(del(t, { ...env, DB: db })).rejects.toThrow("D1 is unavailable");
    expect(failed).toBe(true);
  }, T);

  // Ported from the re-review (RR4, Minor 2): a failing lease check after a failed batch says nothing about the lease, so it
  // is not reported as lease_lost; the batch's error surfaces (a retry finishes).
  it("keeps the final batch's own error, not lease_lost, when the lease check after it throws", async () => {
    const t = await seedClosingOwner(env, "lease-check-throws");
    let failed = false;
    const db = watchDb(env.DB, async (call) => {
      if (isFinalBatch(call)) {
        failed = true;
        throw new Error("D1 is unavailable");
      }
      if (failed && call.method === "all" && call.sql.startsWith("SELECT id, admin_lock FROM sites WHERE owner_id")) throw new Error("the lease check failed");
    });
    await expect(del(t, { ...env, DB: db })).rejects.toThrow("D1 is unavailable");
    expect(failed).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM owners WHERE id = ?", t.ownerId)).toBe(1);
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

describe("deleteOwner and an upload in flight", () => {
  it("purges a MEDIA object that lands after the takedown's purge (the second MEDIA purge of each site)", async () => {
    const { target } = await pair();
    let late = false;
    const live = watchBucket(env.LIVE, async (call, arg) => {
      // The LIVE sweep is the first listing of the whole bucket; by then every takedown purge has run.
      if (call === "list" && (arg as R2ListOptions | undefined)?.prefix === "" && !late) {
        late = true;
        await env.MEDIA.put(`${target.a.siteId}/${newId()}.webp`, "late photo");
      }
    });
    const counts = deletedCounts(await del(target, { ...env, LIVE: live }));
    expect(late).toBe(true);
    expect(counts.objects.media).toBe(target.expected.media + 1);
    expect(await listBucket(env.MEDIA, mediaSitePrefix(target.a.siteId))).toEqual([]);
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
