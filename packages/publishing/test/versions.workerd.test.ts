import { canonicalJson, documentSha256, formActionUrl, LIMITS, newId, OwnerEdits, sha256Hex, versionKey } from "@asksite/core";
import { render } from "@asksite/renderer";
import { SITE_CSS, SITE_CSS_SHA256 } from "@asksite/site-css";
import type { SiteDocument } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPendingVersion, withdrawPending } from "../src/index.ts";
import { publishFailure as failure } from "./support/errors.ts";
import { auditActions, doc, EDITS, publishingHarness, ROOT, seedSite, siteRow, versionRow, type PublishEnv } from "./support/harness.ts";

const harness = publishingHarness("publishing-versions-test");
let env: PublishEnv;
beforeAll(async () => {
  env = await harness.start();
}, 120_000);
afterAll(async () => {
  await harness.server.close();
});

/**
 * Production D1: "`results` is empty for write operations such as UPDATE, DELETE, or INSERT"
 * (developers.cloudflare.com/d1/worker-api/prepared-statements/). Local D1 still returns RETURNING rows,
 * so this D1 empties the results of every write in a batch, as production does (amendment A10).
 */
function writesReturnNoRows(db: D1Database): D1Database {
  const writes = new WeakSet<D1PreparedStatement>();
  const production = {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      if (!/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) return statement;
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          writes.add(bound);
          return bound;
        },
      };
    },
    async batch(statements: D1PreparedStatement[]) {
      const isWrite = statements.map((statement) => writes.has(statement));
      return (await db.batch(statements)).map((result, i) => (isWrite[i] ? { ...result, results: [] } : result));
    },
  };
  return production as unknown as D1Database;
}

/**
 * A D1 whose batch waits until release(), so a test can run a second request between this request's
 * reads and its writes: a race, in a fixed order.
 */
function holdBatch(db: D1Database) {
  let arrive = () => {};
  let release = () => {};
  const reached = new Promise<void>((resolve) => (arrive = () => resolve()));
  const released = new Promise<void>((resolve) => (release = () => resolve()));
  const held = {
    prepare: (sql: string) => db.prepare(sql),
    async batch(statements: D1PreparedStatement[]) {
      arrive();
      await released;
      return db.batch(statements);
    },
  };
  return { db: held as unknown as D1Database, reached, release };
}

async function auditRows(db: D1Database, siteId: string) {
  const { results } = await db.prepare("SELECT at, actor, action, detail_json FROM audit_log WHERE site_id = ? ORDER BY id").bind(siteId).all();
  return results;
}

describe("createPendingVersion", () => {
  it("stores the exact rendered page and a pending version pointing at it", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const document = doc();
    const summary = await createPendingVersion(env, { siteId, ownerId, slug, document, edits: EDITS, generationId: null, now: 1000 });
    expect(summary).toMatchObject({ number: 1, status: "pending", requestedAt: 1000, reviewedAt: null, reviewNote: null });

    const expected = render(document, { stylesheet: SITE_CSS, formAction: formActionUrl(ROOT, slug, siteId) });
    const object = await env.WORK.get(versionKey(siteId, summary.id));
    expect(await object?.text()).toBe(expected);
    expect(object?.httpMetadata?.contentType).toBe("text/html; charset=utf-8");
    expect(object?.customMetadata).toEqual({ siteId, versionId: summary.id, sha256: await sha256Hex(expected) });
    expect(expected).toContain(`action="https://${slug}.asksite.example/_f/${siteId}"`);

    expect(await versionRow(env.DB, summary.id)).toMatchObject({
      site_id: siteId, number: 1, status: "pending",
      document_json: canonicalJson(document), document_sha256: await documentSha256(document),
      edits_json: canonicalJson(EDITS), generation_id: null,
      html_key: versionKey(siteId, summary.id), html_sha256: await sha256Hex(expected), stylesheet_sha256: SITE_CSS_SHA256,
      requested_by: ownerId, requested_at: 1000, reviewed_by: null,
    });
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBe(summary.id);
    expect(await auditActions(env.DB, siteId)).toEqual(["version.requested"]);
  });

  it("records where the version came from: the generation, the owner's edits, who asked and when", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const generationId = newId();
    await env.DB.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at) VALUES (?, ?, ?, 'first', 'succeeded', '{}', 1)")
      .bind(generationId, siteId, ownerId).run();
    // Plan 4's admin review reads generation_id and edits_json to mark the wording the owner changed.
    const edits = OwnerEdits.parse({ baseGenerationId: generationId, copy: { heroHeadline: "Friendly local plumbing help" }, order: null, hidden: ["faq"], theme: null });
    const summary = await createPendingVersion(env, { siteId, ownerId, slug, document: doc(), edits, generationId, now: 7 });
    expect(await versionRow(env.DB, summary.id)).toMatchObject({ generation_id: generationId, edits_json: canonicalJson(edits) });
    expect(await env.DB.prepare("SELECT updated_at FROM sites WHERE id = ?").bind(siteId).first("updated_at")).toBe(7);
    expect(await auditRows(env.DB, siteId)).toEqual([
      { at: 7, actor: `owner:${ownerId}`, action: "version.requested", detail_json: canonicalJson({ versionId: summary.id }) },
    ]);
  });

  it("reads the version number with a SELECT in the batch, since production D1 returns no rows for writes (A10)", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const production = { ...env, DB: writesReturnNoRows(env.DB) };
    const publish = (now: number) => createPendingVersion(production, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now });
    const first = await publish(1);
    const second = await publish(2);
    expect([first.number, second.number]).toEqual([1, 2]);
    expect(await versionRow(env.DB, second.id)).toMatchObject({ number: 2, status: "pending" });
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBe(second.id);

    // No row from the SELECT means the INSERT did not happen: the same refusal as before.
    await env.DB.prepare("UPDATE sites SET taken_down_at = 3 WHERE id = ?").bind(siteId).run();
    expect((await failure(publish(4))).code).toBe("site_taken_down");
    expect((await versionRow(env.DB, second.id))?.status).toBe("pending");
    expect(await auditActions(env.DB, siteId)).toEqual(["version.requested", "version.requested"]);
  });

  it("supersedes the version already in review", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const first = await createPendingVersion(env, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 1 });
    const second = await createPendingVersion(env, { siteId, ownerId, slug, document: doc("hvac-phoenix"), edits: EDITS, generationId: null, now: 2 });
    expect(second.number).toBe(2);
    expect((await versionRow(env.DB, first.id))?.status).toBe("superseded");
    expect((await versionRow(env.DB, second.id))?.status).toBe("pending");
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBe(second.id);
  });

  it("stores the parsed document whatever the caller passed", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const document = doc();
    const untrimmed = { ...document, copy: { ...document.copy, heroHeadline: `  ${document.copy.heroHeadline}  ` } } as SiteDocument;
    const summary = await createPendingVersion(env, { siteId, ownerId, slug, document: untrimmed, edits: EDITS, generationId: null, now: 1 });
    const row = await versionRow(env.DB, summary.id);
    expect(row?.document_sha256).toBe(await documentSha256(document));
    // The stored JSON is the parsed document's, and document_sha256 is the hash of that very JSON (design §2.5).
    expect(row?.document_json).toBe(canonicalJson(document));
    expect(row?.document_sha256).toBe(await sha256Hex(row?.document_json as string));
    // And the stored page is the page of that stored document.
    const page = render(document, { stylesheet: SITE_CSS, formAction: formActionUrl(ROOT, slug, siteId) });
    expect(await (await env.WORK.get(versionKey(siteId, summary.id)))?.text()).toBe(page);
  });

  it("refuses an invalid document with its issues and writes nothing", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const document = doc();
    const invalid = { ...document, copy: { ...document.copy, heroHeadline: "Call 512-555-0142" } } as SiteDocument;
    const error = await failure(createPendingVersion(env, { siteId, ownerId, slug, document: invalid, edits: EDITS, generationId: null, now: 1 }));
    expect(error.code).toBe("render_failed");
    expect(error.detail).toEqual([
      { path: ["copy", "heroHeadline"], code: "custom", message: "Copy must not contain numbers, currency symbols, @ or links; facts come from the owner" },
    ]);
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBeNull();
    expect(await auditActions(env.DB, siteId)).toEqual([]);
  });

  it("refuses a taken-down site and keeps the version already in review", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const first = await createPendingVersion(env, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 1 });
    await env.DB.prepare("UPDATE sites SET taken_down_at = 5 WHERE id = ?").bind(siteId).run();
    const error = await failure(createPendingVersion(env, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 6 }));
    expect(error.code).toBe("site_taken_down");
    expect((await versionRow(env.DB, first.id))?.status).toBe("pending");
    expect(await auditActions(env.DB, siteId)).toEqual(["version.requested"]);
  });

  it("refuses when the slug or the owner no longer matches (integrity)", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const wrongSlug = await failure(createPendingVersion(env, { siteId, ownerId, slug: `${slug}-x`, document: doc(), edits: EDITS, generationId: null, now: 1 }));
    expect(wrongSlug.code).toBe("integrity");
    const other = await seedSite(env.DB);
    const wrongOwner = await failure(createPendingVersion(env, { siteId, ownerId: other.ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 1 }));
    expect(wrongOwner.code).toBe("integrity");
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBeNull();
  });
});

describe("the daily publish cap (Decision 25)", () => {
  const versionCount = async (siteId: string) =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM site_versions WHERE site_id = ?").bind(siteId).first<{ n: number }>())?.n;
  const pendingIds = async (siteId: string) =>
    (await env.DB.prepare("SELECT id FROM site_versions WHERE site_id = ? AND status = 'pending'").bind(siteId).all<{ id: string }>()).results.map((r) => r.id);

  it("allows LIMITS.publishRequestsPerSitePerDay requests a UTC day, then refuses without storing anything", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const day = Date.parse("2026-09-24T00:00:00.000Z");
    const publish = (now: number) => createPendingVersion(env, { siteId, ownerId, slug, document: doc("cleaning-minimal"), edits: EDITS, generationId: null, now });
    for (let i = 0; i < LIMITS.publishRequestsPerSitePerDay; i++) await publish(day + i);
    const error = await failure(publish(day + 3_600_000));
    expect(error.code).toBe("publish_cap_reached");
    expect(error.detail).toEqual({ retryAfter: 82_800 }); // 23 hours until 00:00 UTC
    expect(await versionCount(siteId)).toBe(LIMITS.publishRequestsPerSitePerDay);
    expect((await env.WORK.list({ prefix: `versions/${siteId}/` })).objects).toHaveLength(LIMITS.publishRequestsPerSitePerDay);
    expect((await publish(day + 86_400_000)).number).toBe(LIMITS.publishRequestsPerSitePerDay + 1);
  });

  it("rounds retryAfter up, so a client is never told to come back before 00:00 UTC", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const day = Date.parse("2026-09-26T00:00:00.000Z");
    const publish = (now: number) => createPendingVersion(env, { siteId, ownerId, slug, document: doc("cleaning-minimal"), edits: EDITS, generationId: null, now });
    for (let i = 0; i < LIMITS.publishRequestsPerSitePerDay; i++) await publish(day + i);
    expect((await failure(publish(day + 3_600_001))).detail).toEqual({ retryAfter: 82_800 }); // 82,799.999 s left
    expect((await failure(publish(day + 86_399_999))).detail).toEqual({ retryAfter: 1 }); // 0.001 s left, never 0
  });

  it("stays exact when requests race: one of three gets the last place", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const day = Date.parse("2026-09-25T00:00:00.000Z");
    const publish = (now: number) => createPendingVersion(env, { siteId, ownerId, slug, document: doc("cleaning-minimal"), edits: EDITS, generationId: null, now });
    for (let i = 0; i < LIMITS.publishRequestsPerSitePerDay - 1; i++) await publish(day + i);
    const results = await Promise.allSettled([publish(day + 100), publish(day + 101), publish(day + 102)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "publish_cap_reached" });
    expect(await versionCount(siteId)).toBe(LIMITS.publishRequestsPerSitePerDay);
    // The refused racers changed nothing: the winner is the one version in review, and the site points at it.
    const [winner] = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    expect(await pendingIds(siteId)).toEqual([winner?.id]);
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBe(winner?.id);
  });

  it("a request that passed the early count but lost the last place never touches the winner's version in review", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const day = Date.parse("2026-09-27T00:00:00.000Z");
    const input = (now: number) => ({ siteId, ownerId, slug, document: doc("cleaning-minimal"), edits: EDITS, generationId: null, now });
    for (let i = 0; i < LIMITS.publishRequestsPerSitePerDay - 1; i++) await createPendingVersion(env, input(day + i));
    const held = holdBatch(env.DB);
    const late = createPendingVersion({ ...env, DB: held.db }, input(day + 100));
    await Promise.race([held.reached, late]); // its early count saw one place left
    const winner = await createPendingVersion(env, input(day + 101)); // then another request took it
    held.release();
    expect((await failure(late)).code).toBe("publish_cap_reached");
    expect(await pendingIds(siteId)).toEqual([winner.id]);
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBe(winner.id);
    expect(await versionCount(siteId)).toBe(LIMITS.publishRequestsPerSitePerDay);
    expect(await auditActions(env.DB, siteId)).toHaveLength(LIMITS.publishRequestsPerSitePerDay);
  });
});

describe("withdrawPending", () => {
  it("withdraws the version in review once", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const version = await createPendingVersion(env, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 1 });
    await withdrawPending(env, { siteId, ownerId, now: 2 });
    expect((await versionRow(env.DB, version.id))?.status).toBe("withdrawn");
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBeNull();
    expect(await auditActions(env.DB, siteId)).toEqual(["version.requested", "version.withdrawn"]);
    expect((await failure(withdrawPending(env, { siteId, ownerId, now: 3 }))).code).toBe("nothing_pending");
    expect(await auditActions(env.DB, siteId)).toEqual(["version.requested", "version.withdrawn"]);
  });

  it("does nothing for another owner's site", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    await createPendingVersion(env, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 1 });
    const other = await seedSite(env.DB);
    expect((await failure(withdrawPending(env, { siteId, ownerId: other.ownerId, now: 2 }))).code).toBe("nothing_pending");
    expect((await siteRow(env.DB, siteId))?.pending_version_id).not.toBeNull();
  });

  it("a double-clicked withdraw withdraws and logs once", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const version = await createPendingVersion(env, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 1 });
    const held = holdBatch(env.DB);
    const firstClick = withdrawPending({ DB: held.db }, { siteId, ownerId, now: 2 });
    await Promise.race([held.reached, firstClick]); // both clicks read the same version in review
    await withdrawPending(env, { siteId, ownerId, now: 3 });
    held.release();
    expect((await failure(firstClick)).code).toBe("nothing_pending");
    expect((await versionRow(env.DB, version.id))?.status).toBe("withdrawn");
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBeNull();
    expect(await auditRows(env.DB, siteId)).toEqual([
      { at: 1, actor: `owner:${ownerId}`, action: "version.requested", detail_json: canonicalJson({ versionId: version.id }) },
      { at: 3, actor: `owner:${ownerId}`, action: "version.withdrawn", detail_json: canonicalJson({ versionId: version.id }) },
    ]);
  });

  it("a withdraw overtaken by a new publish leaves the new version in review", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const publish = (now: number) => createPendingVersion(env, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now });
    const first = await publish(1);
    const held = holdBatch(env.DB);
    const withdraw = withdrawPending({ DB: held.db }, { siteId, ownerId, now: 2 });
    await Promise.race([held.reached, withdraw]); // it read the first version as the one in review
    const second = await publish(3);
    held.release();
    expect((await failure(withdraw)).code).toBe("nothing_pending");
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBe(second.id);
    expect((await versionRow(env.DB, second.id))?.status).toBe("pending");
    expect((await versionRow(env.DB, first.id))?.status).toBe("superseded");
    expect(await auditActions(env.DB, siteId)).toEqual(["version.requested", "version.requested"]);
  });
});
