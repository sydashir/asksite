import { canonicalJson, documentSha256, formActionUrl, LIMITS, newId, OwnerEdits, pagesDigest, sha256Hex, siteUrl, versionKey, versionPageKey, type VersionPages } from "@asksite/core";
import { render } from "@asksite/renderer";
import { DESIGN_CSS } from "@asksite/site-css";
import { DESIGN_IDS, PAGE_IDS, type SiteDocument } from "@asksite/site-schema";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

type Site = Awaited<ReturnType<typeof seedSite>>;

// The renderer gives each fixture the pages its content gives it (A16): plumber-austin all five, cleaning-minimal
// Home, Services and Contact. Every version stores one WORK object per page.
const PLUMBER_PAGES = 5;
const CLEANING_PAGES = 3;

/** Another site of the same owner: an owner who accepts a second invite gets one (Plan 4's invite accept). */
async function secondSite(db: D1Database, ownerId: string): Promise<Site> {
  const siteId = newId();
  const slug = `second-${siteId.slice(0, 8)}`;
  await db.prepare("INSERT INTO sites (id, owner_id, slug, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").bind(siteId, ownerId, slug).run();
  return { ownerId, siteId, slug };
}

/** A finished generation of `site`; returns its id. */
async function generationOf(site: Site): Promise<string> {
  const generationId = newId();
  await env.DB.prepare("INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at) VALUES (?, ?, ?, 'first', 'succeeded', '{}', 1)")
    .bind(generationId, site.siteId, site.ownerId).run();
  return generationId;
}

/**
 * A D1 whose batch answers the version-number SELECT with no row although the INSERT before it happened:
 * A10's inference (a later read in a batch sees the earlier write) failing, as production D1 could.
 */
function numberReadSeesNothing(db: D1Database): D1Database {
  const hidden = new WeakSet<D1PreparedStatement>();
  const production = {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      if (!/^SELECT number FROM site_versions WHERE id = \?$/.test(sql)) return statement;
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          hidden.add(bound);
          return bound;
        },
      };
    },
    async batch(statements: D1PreparedStatement[]) {
      const isHidden = statements.map((statement) => hidden.has(statement));
      return (await db.batch(statements)).map((result, i) => (isHidden[i] ? { ...result, results: [] } : result));
    },
  };
  return production as unknown as D1Database;
}

/** The WORK key of every page of a version, from its row's pages_json (sorted, as a listing is). */
async function allPageKeys(siteId: string, versionId: string): Promise<string[]> {
  const pages = JSON.parse(String((await versionRow(env.DB, versionId))?.pages_json)) as Array<{ page: "home" | "services" | "about" | "gallery" | "contact" }>;
  return pages.map((p) => versionPageKey(siteId, versionId, p.page)).sort();
}

/** The keys of a site's stored pages in WORK (R2 lists are strongly consistent). */
async function workKeys(siteId: string): Promise<string[]> {
  return (await env.WORK.list({ prefix: `versions/${siteId}/` })).objects.map((object) => object.key);
}

describe("createPendingVersion", () => {
  it("stores every rendered page of plumber-austin and a pending version pointing at them", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const document = doc();
    const summary = await createPendingVersion(env, { siteId, ownerId, slug, document, edits: EDITS, generationId: null, now: 1000 });
    expect(summary).toMatchObject({ number: 1, status: "pending", requestedAt: 1000, reviewedAt: null, reviewNote: null });

    const expected = render(document, { stylesheets: DESIGN_CSS, formAction: formActionUrl(ROOT, slug, siteId), siteUrl: siteUrl(ROOT, slug) });
    expect(expected.pages.map((p) => p.page)).toEqual(["home", "services", "about", "gallery", "contact"]);
    const pages: VersionPages = await Promise.all(expected.pages.map(async (p) => ({ page: p.page, sha256: await sha256Hex(p.html) })));
    expect(await workKeys(siteId)).toEqual(expected.pages.map((p) => versionPageKey(siteId, summary.id, p.page)).sort());
    for (const [i, rendered] of expected.pages.entries()) {
      const object = await env.WORK.get(versionPageKey(siteId, summary.id, rendered.page));
      expect(await object?.text()).toBe(rendered.html);
      expect(object?.httpMetadata?.contentType).toBe("text/html; charset=utf-8");
      expect(object?.customMetadata).toEqual({ siteId, versionId: summary.id, page: rendered.page, sha256: pages[i]?.sha256 });
    }
    // Home keeps its old key, and the form (on Contact) posts to the site's own address.
    expect(await (await env.WORK.get(versionKey(siteId, summary.id)))?.text()).toBe(expected.pages[0]?.html);
    expect(expected.pages.find((p) => p.page === "contact")?.html).toContain(`action="https://${slug}.asksite.example/_f/${siteId}"`);

    expect(await versionRow(env.DB, summary.id)).toMatchObject({
      site_id: siteId, number: 1, status: "pending",
      document_json: canonicalJson(document), document_sha256: await documentSha256(document),
      edits_json: canonicalJson(EDITS), generation_id: null,
      pages_json: canonicalJson(pages), html_key: versionKey(siteId, summary.id), html_sha256: await pagesDigest(pages), stylesheet_sha256: expected.stylesheetSha256,
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

    // No row from the SELECT means the INSERT did not happen: the same refusal as before. The site is taken
    // down after the early checks, so it is the batch that refuses.
    const held = holdBatch(writesReturnNoRows(env.DB));
    const late = createPendingVersion({ ...env, DB: held.db }, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 4 });
    await Promise.race([held.reached, late]);
    await env.DB.prepare("UPDATE sites SET taken_down_at = 3 WHERE id = ?").bind(siteId).run();
    held.release();
    expect((await failure(late)).code).toBe("site_taken_down");
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

  it("a publish never touches another site's version in review", async () => {
    const a = await seedSite(env.DB);
    const b = await seedSite(env.DB);
    const publish = (site: Site, now: number) =>
      createPendingVersion(env, { ...site, document: doc(), edits: EDITS, generationId: null, now });
    const inReview = await publish(a, 1);
    const other = await publish(b, 2);
    expect(other.number).toBe(1); // numbered per site
    expect((await siteRow(env.DB, b.siteId))?.pending_version_id).toBe(other.id);
    expect((await versionRow(env.DB, inReview.id))?.status).toBe("pending");
    expect((await siteRow(env.DB, a.siteId))?.pending_version_id).toBe(inReview.id);
    expect(await auditActions(env.DB, a.siteId)).toEqual(["version.requested"]);
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
    const site = render(document, { stylesheets: DESIGN_CSS, formAction: formActionUrl(ROOT, slug, siteId), siteUrl: siteUrl(ROOT, slug) });
    expect(await (await env.WORK.get(versionKey(siteId, summary.id)))?.text()).toBe(site.pages[0]!.html);
  });

  // A12: the stored page is drawn in the document's own design and inlines that design's stylesheet, and the
  // version records that sheet's SHA-256, as render() reports it (A12-0 ruling M2).
  it.each(DESIGN_IDS)("stores the page in the %s design with that design's stylesheet", async (design) => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const plumber = doc();
    const document: SiteDocument = { ...plumber, theme: { ...plumber.theme, design } };
    const summary = await createPendingVersion(env, { siteId, ownerId, slug, document, edits: EDITS, generationId: null, now: 1 });

    const page = render(document, { stylesheets: DESIGN_CSS, formAction: formActionUrl(ROOT, slug, siteId), siteUrl: siteUrl(ROOT, slug) });
    expect(page.design).toBe(design);
    for (const rendered of page.pages) {
      const stored = await (await env.WORK.get(versionPageKey(siteId, summary.id, rendered.page)))?.text();
      expect(stored).toBe(rendered.html);
      expect(stored).toContain(`<body data-design="${design}"`);
      expect(stored).toContain(`<style>${DESIGN_CSS[design].css}</style>`);
    }
    const row = await versionRow(env.DB, summary.id);
    const pages = await Promise.all(page.pages.map(async (p) => ({ page: p.page, sha256: await sha256Hex(p.html) })));
    expect(row).toMatchObject({ html_sha256: await pagesDigest(pages as VersionPages), stylesheet_sha256: page.stylesheetSha256 });
    expect(row?.stylesheet_sha256).toBe(DESIGN_CSS[design].sha256);
    expect(JSON.parse(row?.document_json as string).theme.design).toBe(design);
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

  it("answers render_failed when the renderer refuses the page, and stores nothing", async () => {
    const { ownerId, siteId } = await seedSite(env.DB);
    // A slug no host can hold: the form address is not a safe URL, so render() throws (renderer safeUrl).
    const slug = `bad slug ${siteId.slice(0, 8)}`;
    await env.DB.prepare("UPDATE sites SET slug = ? WHERE id = ?").bind(slug, siteId).run();
    const error = await failure(createPendingVersion(env, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 1 }));
    expect(error.code).toBe("render_failed");
    expect(error.detail).toEqual([
      { path: [], code: "render_failed", message: `Unsafe URL rejected: ${JSON.stringify(formActionUrl(ROOT, slug, siteId))}` },
    ]);
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBeNull();
    expect(await auditActions(env.DB, siteId)).toEqual([]);
    expect((await env.WORK.list({ prefix: `versions/${siteId}/` })).objects).toEqual([]);
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
    // Plan 4 answers 409 "send it again" only for this reason, and 500 for any other integrity error.
    expect(wrongSlug.detail).toEqual({ reason: "site_changed" });
    const other = await seedSite(env.DB);
    const wrongOwner = await failure(createPendingVersion(env, { siteId, ownerId: other.ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 1 }));
    expect(wrongOwner.code).toBe("integrity");
    expect(wrongOwner.detail).toEqual({ reason: "site_changed" });
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBeNull();
  });

  it("never tells another owner that a site is taken down", async () => {
    const { siteId, slug } = await seedSite(env.DB);
    const intruder = await seedSite(env.DB);
    await env.DB.prepare("UPDATE sites SET taken_down_at = 5 WHERE id = ?").bind(siteId).run();
    const error = await failure(createPendingVersion(env, { siteId, ownerId: intruder.ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 6 }));
    expect(error.code).toBe("integrity");
    expect(error.detail).toEqual({ reason: "site_changed" });
  });

  it("a refused publish (another owner, or the slug of the owner's other site) leaves the version in review alone", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const otherSite = await secondSite(env.DB, ownerId);
    const intruder = await seedSite(env.DB);
    const inReview = await createPendingVersion(env, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 1 });
    const publishAs = (asOwner: string, withSlug: string) =>
      createPendingVersion(env, { siteId, ownerId: asOwner, slug: withSlug, document: doc(), edits: EDITS, generationId: null, now: 2 });
    expect((await failure(publishAs(intruder.ownerId, slug))).code).toBe("integrity");
    expect((await failure(publishAs(ownerId, otherSite.slug))).code).toBe("integrity");
    expect((await versionRow(env.DB, inReview.id))?.status).toBe("pending");
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBe(inReview.id);
    expect(await auditActions(env.DB, siteId)).toEqual(["version.requested"]);
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
    expect((await env.WORK.list({ prefix: `versions/${siteId}/` })).objects).toHaveLength(LIMITS.publishRequestsPerSitePerDay * CLEANING_PAGES);
    // The cap counts each site on its own: the same day, another site still publishes, and its second request
    // supersedes its first.
    const other = await seedSite(env.DB);
    const publishOther = (now: number) => createPendingVersion(env, { ...other, document: doc("cleaning-minimal"), edits: EDITS, generationId: null, now });
    const otherFirst = await publishOther(day + 3_600_000);
    const otherSecond = await publishOther(day + 3_600_001);
    expect([otherFirst.number, otherSecond.number]).toEqual([1, 2]);
    expect((await versionRow(env.DB, otherFirst.id))?.status).toBe("superseded");
    expect((await publish(day + 86_400_000)).number).toBe(LIMITS.publishRequestsPerSitePerDay + 1);
  });

  it("counts every request, whatever became of it, so publish and withdraw cannot loop past the cap", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const day = Date.parse("2026-09-28T00:00:00.000Z");
    const publish = (now: number) => createPendingVersion(env, { siteId, ownerId, slug, document: doc("cleaning-minimal"), edits: EDITS, generationId: null, now });
    for (let i = 0; i < LIMITS.publishRequestsPerSitePerDay; i++) {
      await publish(day + 2 * i);
      await withdrawPending(env, { siteId, ownerId, now: day + 2 * i + 1 });
    }
    // Reviewed ones count too (set here by SQL; review itself is Task 9's).
    await env.DB.prepare("UPDATE site_versions SET status = 'approved' WHERE site_id = ? AND number IN (1, 2)").bind(siteId).run();
    await env.DB.prepare("UPDATE site_versions SET status = 'rejected' WHERE site_id = ? AND number IN (3, 4)").bind(siteId).run();
    expect((await failure(publish(day + 3_600_000))).code).toBe("publish_cap_reached");
    expect(await versionCount(siteId)).toBe(LIMITS.publishRequestsPerSitePerDay);
    expect((await env.WORK.list({ prefix: `versions/${siteId}/` })).objects).toHaveLength(LIMITS.publishRequestsPerSitePerDay * CLEANING_PAGES);
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
    expect(await workKeys(siteId)).toHaveLength(LIMITS.publishRequestsPerSitePerDay * CLEANING_PAGES); // no refused racer left its pages
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
    expect(await workKeys(siteId)).toHaveLength((LIMITS.publishRequestsPerSitePerDay + 1) * CLEANING_PAGES); // both stored their pages
    held.release();
    expect((await failure(late)).code).toBe("publish_cap_reached");
    expect(await pendingIds(siteId)).toEqual([winner.id]);
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBe(winner.id);
    expect(await versionCount(siteId)).toBe(LIMITS.publishRequestsPerSitePerDay);
    expect(await auditActions(env.DB, siteId)).toHaveLength(LIMITS.publishRequestsPerSitePerDay);
    // The loser's pages are gone: WORK holds exactly the pages of the stored versions.
    const stored = await env.DB.prepare("SELECT id FROM site_versions WHERE site_id = ?").bind(siteId).all<{ id: string }>();
    expect(await workKeys(siteId)).toEqual((await Promise.all(stored.results.map((r) => allPageKeys(siteId, r.id)))).flat().sort());
  });
});

describe("a request the early checks refuse", () => {
  const day = Date.parse("2026-09-29T00:00:00.000Z");
  const now = day + 3_600_000;
  const fillTodaysCap = async (site: Site) => {
    for (let i = 0; i < LIMITS.publishRequestsPerSitePerDay; i++) {
      await createPendingVersion(env, { ...site, document: doc("cleaning-minimal"), edits: EDITS, generationId: null, now: day + i });
    }
  };
  const siteChanged = { code: "integrity", detail: { reason: "site_changed" } };
  const refusals: { request: string; refused: { code: string; detail?: unknown }; arrange: (site: Site) => Promise<Partial<Site & { generationId: string }>> }[] = [
    { request: "for another owner's site", refused: siteChanged, arrange: async () => ({ ownerId: (await seedSite(env.DB)).ownerId }) },
    {
      // Ownership comes first: another owner never learns that the site is at its cap.
      request: "for another owner's site at its cap",
      refused: siteChanged,
      arrange: async (site) => {
        await fillTodaysCap(site);
        return { ownerId: (await seedSite(env.DB)).ownerId };
      },
    },
    {
      request: "for a taken-down site",
      refused: { code: "site_taken_down" },
      arrange: async (site) => {
        await env.DB.prepare("UPDATE sites SET taken_down_at = 1 WHERE id = ?").bind(site.siteId).run();
        return {};
      },
    },
    {
      request: "over today's cap",
      refused: { code: "publish_cap_reached", detail: { retryAfter: 82_800 } },
      arrange: async (site) => {
        await fillTodaysCap(site);
        return {};
      },
    },
    { request: "with an address the site does not have", refused: siteChanged, arrange: async (site) => ({ slug: `${site.slug}-x` }) },
    {
      // Not a raw D1 FOREIGN KEY error: a PublishError that Plan 4 answers with its shared 500.
      request: "naming a generation that does not exist",
      refused: { code: "integrity", detail: { reason: "generation_not_found" } },
      arrange: async () => ({ generationId: newId() }),
    },
    {
      // Provenance is the site's own generation (generations.site_id), never another owner's site's.
      request: "naming another owner's site's generation",
      refused: { code: "integrity", detail: { reason: "generation_not_found" } },
      arrange: async () => ({ generationId: await generationOf(await seedSite(env.DB)) }),
    },
    {
      // Nor the same owner's other site's: the check is scoped to the site, not only to the owner.
      request: "naming a generation of the owner's other site",
      refused: { code: "integrity", detail: { reason: "generation_not_found" } },
      arrange: async (site) => ({ generationId: await generationOf(await secondSite(env.DB, site.ownerId)) }),
    },
  ];

  it.each(refusals)("a request $request is refused before a page is stored", async ({ refused, arrange }) => {
    const site = await seedSite(env.DB);
    const request = { ...site, document: doc(), edits: EDITS, generationId: null, now, ...(await arrange(site)) };
    const before = { pages: await workKeys(site.siteId), site: await siteRow(env.DB, site.siteId), audit: await auditActions(env.DB, site.siteId) };
    const puts: string[] = [];
    const counted = {
      put: (...args: Parameters<R2Bucket["put"]>) => (puts.push(args[0]), env.WORK.put(...args)),
      delete: (...args: Parameters<R2Bucket["delete"]>) => env.WORK.delete(...args),
    } as unknown as R2Bucket;
    const error = await failure(createPendingVersion({ ...env, WORK: counted }, request));
    expect({ code: error.code, detail: error.detail }).toEqual(refused);
    expect(puts).toEqual([]);
    expect({ pages: await workKeys(site.siteId), site: await siteRow(env.DB, site.siteId), audit: await auditActions(env.DB, site.siteId) }).toEqual(before);
  });
});

describe("a request the batch refuses, because the site changed after the early checks", () => {
  const changes: { change: string; code: string; detail?: unknown; apply: (site: Site) => Promise<unknown> }[] = [
    {
      change: "was taken down",
      code: "site_taken_down",
      apply: (site) => env.DB.prepare("UPDATE sites SET taken_down_at = 2 WHERE id = ?").bind(site.siteId).run(),
    },
    {
      change: "got a new address",
      code: "integrity",
      detail: { reason: "site_changed" },
      apply: (site) => env.DB.prepare("UPDATE sites SET slug = ? WHERE id = ?").bind(`${site.slug}-new`, site.siteId).run(),
    },
    {
      change: "gave its old address to the owner's other site",
      code: "integrity",
      detail: { reason: "site_changed" },
      apply: async (site) => {
        const other = await secondSite(env.DB, site.ownerId);
        await env.DB.prepare("UPDATE sites SET slug = ? WHERE id = ?").bind(`${site.slug}-new`, site.siteId).run();
        await env.DB.prepare("UPDATE sites SET slug = ? WHERE id = ?").bind(site.slug, other.siteId).run();
      },
    },
    {
      // No code moves a site between owners today; the batch still re-checks the owner.
      change: "passed to another owner",
      code: "integrity",
      detail: { reason: "site_changed" },
      apply: async (site) => {
        const other = await seedSite(env.DB);
        await env.DB.prepare("UPDATE sites SET owner_id = ? WHERE id = ?").bind(other.ownerId, site.siteId).run();
      },
    },
  ];

  it.each(changes)("the site $change: deletes the page it stored and leaves the version in review alone", async ({ code, detail, apply }) => {
    const site = await seedSite(env.DB);
    const publish = (db: D1Database, now: number) => createPendingVersion({ ...env, DB: db }, { ...site, document: doc(), edits: EDITS, generationId: null, now });
    const inReview = await publish(env.DB, 1);
    const before = await workKeys(site.siteId);
    const held = holdBatch(env.DB);
    const late = publish(held.db, 3);
    await Promise.race([held.reached, late]); // it passed the early checks and stored its page
    expect(await workKeys(site.siteId)).toHaveLength(before.length + PLUMBER_PAGES);
    await apply(site);
    held.release();
    const error = await failure(late);
    expect({ code: error.code, detail: error.detail }).toEqual({ code, detail });
    expect(await workKeys(site.siteId)).toEqual(before);
    expect((await versionRow(env.DB, inReview.id))?.status).toBe("pending");
    expect((await siteRow(env.DB, site.siteId))?.pending_version_id).toBe(inReview.id);
    expect(await auditActions(env.DB, site.siteId)).toEqual(["version.requested"]);
  });

  it("answers site_changed when the change is undone before the refusal is explained", async () => {
    const site = await seedSite(env.DB);
    const rename = (slug: string) => env.DB.prepare("UPDATE sites SET slug = ? WHERE id = ?").bind(slug, site.siteId).run();
    const renamedDuringBatch = {
      prepare: (sql: string) => env.DB.prepare(sql),
      async batch(statements: D1PreparedStatement[]) {
        await rename(`${site.slug}-new`);
        const results = await env.DB.batch(statements);
        await rename(site.slug);
        return results;
      },
    } as unknown as D1Database;
    const error = await failure(createPendingVersion({ ...env, DB: renamedDuringBatch }, { ...site, document: doc(), edits: EDITS, generationId: null, now: 1 }));
    expect({ code: error.code, detail: error.detail }).toEqual({ code: "integrity", detail: { reason: "site_changed" } });
    expect(await workKeys(site.siteId)).toEqual([]);
    expect((await siteRow(env.DB, site.siteId))?.pending_version_id).toBeNull();
  });

  it("keeps the page when a version row names it although the batch returned no number (A10 is inferred)", async () => {
    const site = await seedSite(env.DB);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = await failure(createPendingVersion({ ...env, DB: numberReadSeesNothing(env.DB) }, { ...site, document: doc(), edits: EDITS, generationId: null, now: 1 }));
      expect({ code: error.code, detail: error.detail }).toEqual({ code: "integrity", detail: { reason: "site_changed" } });
      // The INSERT happened, so its page stays: deleting it would leave a version whose bytes are gone.
      const stored = await env.DB.prepare("SELECT id, html_key FROM site_versions WHERE site_id = ?").bind(site.siteId).all<{ id: string; html_key: string }>();
      expect(stored.results).toHaveLength(1);
      expect(await workKeys(site.siteId)).toEqual(await allPageKeys(site.siteId, String(stored.results[0]?.id)));
      // One line, IDs and a code only, so the broken inference shows in production logs.
      expect(logged).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toEqual({ code: "version_number_missing", siteId: site.siteId, versionId: stored.results[0]?.id });
    } finally {
      logged.mockRestore();
    }
  });

  it("logs a page it could not delete, and still answers the refusal", async () => {
    const site = await seedSite(env.DB);
    const deleteFails = {
      put: (...args: Parameters<R2Bucket["put"]>) => env.WORK.put(...args),
      delete: () => Promise.reject(new Error("R2 is unavailable")),
    } as unknown as R2Bucket;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const held = holdBatch(env.DB);
      const late = createPendingVersion({ ...env, DB: held.db, WORK: deleteFails }, { ...site, document: doc(), edits: EDITS, generationId: null, now: 1 });
      await Promise.race([held.reached, late]);
      await env.DB.prepare("UPDATE sites SET taken_down_at = 2 WHERE id = ?").bind(site.siteId).run();
      held.release();
      expect((await failure(late)).code).toBe("site_taken_down");
      // One line, IDs and a code only (never the error text), naming the page left behind.
      expect(logged).toHaveBeenCalledTimes(1);
      const line = JSON.parse(String(logged.mock.calls[0]?.[0])) as { versionId: string };
      expect(line).toEqual({ code: "refused_page_not_deleted", siteId: site.siteId, versionId: line.versionId });
      // No version row exists (the batch refused it), so the pages left behind are all five of plumber-austin's.
      expect(await workKeys(site.siteId)).toEqual(PAGE_IDS.map((page) => versionPageKey(site.siteId, line.versionId, page)).sort());
    } finally {
      logged.mockRestore();
    }
  });
});

describe("withdrawPending", () => {
  it("withdraws the version in review once", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const version = await createPendingVersion(env, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 1 });
    await withdrawPending(env, { siteId, ownerId, now: 2 });
    expect((await versionRow(env.DB, version.id))?.status).toBe("withdrawn");
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBeNull();
    expect(await env.DB.prepare("SELECT updated_at FROM sites WHERE id = ?").bind(siteId).first("updated_at")).toBe(2);
    expect(await auditActions(env.DB, siteId)).toEqual(["version.requested", "version.withdrawn"]);
    expect((await failure(withdrawPending(env, { siteId, ownerId, now: 3 }))).code).toBe("nothing_pending");
    expect(await auditActions(env.DB, siteId)).toEqual(["version.requested", "version.withdrawn"]);
  });

  it("does nothing for another owner's site", async () => {
    const { ownerId, siteId, slug } = await seedSite(env.DB);
    const version = await createPendingVersion(env, { siteId, ownerId, slug, document: doc(), edits: EDITS, generationId: null, now: 1 });
    const other = await seedSite(env.DB);
    expect((await failure(withdrawPending(env, { siteId, ownerId: other.ownerId, now: 2 }))).code).toBe("nothing_pending");
    expect((await siteRow(env.DB, siteId))?.pending_version_id).toBe(version.id);
    expect((await versionRow(env.DB, version.id))?.status).toBe("pending");
    expect(await auditActions(env.DB, siteId)).toEqual(["version.requested"]);
  });

  it("withdraws only the site it names when the owner has two", async () => {
    const first = await seedSite(env.DB);
    const second = await secondSite(env.DB, first.ownerId);
    const publish = (site: Site, now: number) =>
      createPendingVersion(env, { ...site, document: doc(), edits: EDITS, generationId: null, now });
    const v1 = await publish(first, 1);
    const v2 = await publish(second, 2);
    await withdrawPending(env, { siteId: second.siteId, ownerId: first.ownerId, now: 3 });
    expect((await versionRow(env.DB, v2.id))?.status).toBe("withdrawn");
    expect((await versionRow(env.DB, v1.id))?.status).toBe("pending");
    expect((await siteRow(env.DB, first.siteId))?.pending_version_id).toBe(v1.id);
    // Then the other one, so the check holds whichever site a lookup by owner alone would find first.
    await withdrawPending(env, { siteId: first.siteId, ownerId: first.ownerId, now: 4 });
    expect((await versionRow(env.DB, v1.id))?.status).toBe("withdrawn");
    expect(await auditActions(env.DB, first.siteId)).toEqual(["version.requested", "version.withdrawn"]);
    expect(await auditActions(env.DB, second.siteId)).toEqual(["version.requested", "version.withdrawn"]);
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
