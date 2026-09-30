import { MAX_ISSUES } from "@asksite/app-common";
import { composeDocument, photoRefIssues, toIssues, utcDayStart, type SiteView, type VersionSummary } from "@asksite/core";
import { SiteDocument } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { VALID_BRIEF, VALID_FACTS } from "../support/facts.ts";
import { FAKE_PUBLISH_CAP } from "../support/limits.ts";
import { awayFromUtcHourEnd, builtOwner, json, ROOT, useAppHarness } from "../support/harness.ts";

const h = useAppHarness();

type ErrorJson = { error: { code: string; currentRev?: number; issues?: Array<{ path: unknown[]; code: string }> } };

async function withSlug(owner: Awaited<ReturnType<typeof builtOwner>>, slug: string) {
  const res = await h.call("PUT", `/api/sites/${owner.siteId}/slug`, { cookie: owner.cookie, body: { rev: owner.rev, slug } });
  return { ...owner, rev: ((await res.json()) as { rev: number }).rev };
}

const view = async (owner: { siteId: string; cookie: string }) =>
  json<SiteView>(await h.call("GET", `/api/sites/${owner.siteId}`, { cookie: owner.cookie }));

async function outbox(to: string) {
  for (let i = 0; i < 40; i += 1) {
    const { results } = await (await h.db())
      .prepare("SELECT subject, tag FROM dev_outbox WHERE to_addr = ? ORDER BY id")
      .bind(to)
      .all<{ subject: string; tag: string }>();
    if (results.length > 0) return results;
    await new Promise((r) => setTimeout(r, 100));
  }
  return [];
}

/** The review alerts sent so far for one slug. */
async function sentAlerts(slug: string) {
  return (await (await h.db()).prepare("SELECT subject FROM dev_outbox WHERE to_addr = 'reviewer@example.com' AND subject LIKE ?").bind(`%: ${slug} (%`).all<{ subject: string }>()).results;
}

/** The review alerts sent for one slug, read once they have had time to go out (they run after the response). */
async function alertsFor(slug: string) {
  for (let i = 0; i < 40 && (await sentAlerts(slug)).length === 0; i += 1) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 500));
  return sentAlerts(slug);
}

/** Asks to publish the draft (201) and waits for the request's background work, the alert check, to finish. */
async function publishAndSettle(owner: { siteId: string; cookie: string; rev: number }): Promise<VersionSummary> {
  const res = await h.call("POST", `/api/sites/${owner.siteId}/publish-requests`, { cookie: owner.cookie, body: { rev: owner.rev } });
  expect(res.status).toBe(201);
  await h.backgroundDone(`/api/sites/${owner.siteId}/publish-requests`);
  return (await json<{ version: VersionSummary }>(res)).version;
}

/** How many versions a site has, whatever their status. */
async function versionCount(siteId: string): Promise<number | undefined> {
  return (await (await h.db()).prepare("SELECT COUNT(*) AS n FROM site_versions WHERE site_id = ?").bind(siteId).first<{ n: number }>())?.n;
}

/** Decision 32's quiet time: a site's requests alert the reviewers at most once an hour. */
const HOUR_MS = 3_600_000;

/** A stored version of the site with this number, asked for at this time (all the review-alert rule reads). */
async function seedVersion(site: { siteId: string; ownerId: string }, number: number, requestedAt: number): Promise<void> {
  await (await h.db())
    .prepare(
      `INSERT INTO site_versions (id, site_id, number, status, document_json, document_sha256, edits_json, html_key, html_sha256,
         stylesheet_sha256, requested_by, requested_at)
       VALUES (?, ?, ?, 'superseded', '{}', 'x', '{}', 'x', 'x', 'x', ?, ?)`,
    )
    .bind(crypto.randomUUID(), site.siteId, number, site.ownerId, requestedAt)
    .run();
}

/**
 * Starts today's review-alert count again from nothing: every version asked for today moves two days back, keeping
 * its order and spacing. For a test that needs the day's alert allowance to itself.
 */
async function startAlertDayAfresh(): Promise<void> {
  await (await h.db()).prepare("UPDATE site_versions SET requested_at = requested_at - ? WHERE requested_at >= ?").bind(2 * 86_400_000, utcDayStart(Date.now())).run();
}

/**
 * A request A of a new site that an earlier-timed request B of the same site overtakes, near the hour mark of the
 * site's alerted request x (security review r3, I1): x was asked just over an hour before A; B was asked just before
 * x's hour ended, so before A, yet commits after A. B commits after A's alert check (ordering O1), or before it (O2;
 * O3 is covered by O2, see the cap test). By version number A is the site's first request in an hour: it alerts.
 */
async function overtakenRequest(slug: string, bCommits: "after A's alert check" | "before A's alert check"): Promise<void> {
  const owner = await withSlug(await builtOwner(h, VALID_FACTS, VALID_BRIEF), slug);
  const now = Date.now();
  await seedVersion(owner, 1, now - HOUR_MS - 1_000);
  const bAskedAt = now - 2_000;
  if (bCommits === "before A's alert check") {
    expect((await h.call("POST", "/__test/twin-after-batch", { body: { siteId: owner.siteId, requestedAt: bAskedAt } })).status).toBe(200);
  }
  expect((await publishAndSettle(owner)).number).toBe(2);
  if (bCommits === "after A's alert check") await seedVersion(owner, 3, bAskedAt);
  const rows = (await (await h.db()).prepare("SELECT number, requested_at FROM site_versions WHERE site_id = ? ORDER BY number").bind(owner.siteId).all<{ number: number; requested_at: number }>()).results;
  expect(rows.map((row) => row.number)).toEqual([1, 2, 3]);
  const [x, a, b] = rows.map((row) => row.requested_at) as [number, number, number];
  expect(a - x).toBeGreaterThan(HOUR_MS); // A: past x's hour
  expect(b - x).toBeLessThan(HOUR_MS); // B: within x's hour,
  expect(b).toBeLessThan(a); // and asked before A
  expect(await sentAlerts(slug)).toEqual([{ subject: `Website waiting for review: ${slug} (version 2)` }]);
}

// Before the publish requests below: its rows are dated 1970, so they count toward no cap and no review alert.
describe("GET /api/sites/:siteId/versions", () => {
  it("lists the owner's versions newest first, with a reviewer's note only on a rejected one (P4-12)", async () => {
    const owner = await h.signIn();
    const db = await h.db();
    const statuses = ["approved", "rejected", "withdrawn", "superseded", "pending"] as const;
    for (const [i, status] of statuses.entries()) {
      await db
        .prepare(
          `INSERT INTO site_versions (id, site_id, number, status, document_json, document_sha256, edits_json, html_key, html_sha256,
             stylesheet_sha256, requested_by, requested_at, reviewed_by, reviewed_at, review_note)
           VALUES (?, ?, ?, ?, '{}', 'x', '{}', 'x', 'x', 'x', ?, ?, 'admin@example.com', ?, ?)`,
        )
        .bind(crypto.randomUUID(), owner.siteId, i + 1, status, owner.ownerId, i + 1, i + 2, `Reviewer note on the ${status} version`)
        .run();
    }
    const res = await h.call("GET", `/api/sites/${owner.siteId}/versions`, { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const text = await res.text();
    const { versions } = JSON.parse(text) as { versions: VersionSummary[] };
    expect(versions.map((v) => [v.number, v.status, v.requestedAt, v.reviewedAt, v.reviewNote])).toEqual([
      [5, "pending", 5, 6, null],
      [4, "superseded", 4, 5, null],
      [3, "withdrawn", 3, 4, null],
      [2, "rejected", 2, 3, "Reviewer note on the rejected version"],
      [1, "approved", 1, 2, null],
    ]);
    expect(text.match(/Reviewer note/g)).toHaveLength(1);
  });

  it("reads only the columns a version summary shows, never a version's stored document or edits (m2)", async () => {
    const owner = await h.signIn();
    await seedVersion(owner, 1, 1);
    const path = `/api/sites/${owner.siteId}/versions`;
    await h.recordSql(path);
    const res = await h.call("GET", path, { cookie: owner.cookie });
    expect(res.status).toBe(200);
    expect((await json<{ versions: VersionSummary[] }>(res)).versions.map((v) => v.number)).toEqual([1]);
    const reads = (await h.recordedSql(path)).filter((sql) => /\bFROM site_versions\b/.test(sql));
    expect(reads).toHaveLength(1);
    expect(reads[0]).not.toMatch(/document_json|edits_json/);
    const columns = /^\s*SELECT\s+([\s\S]+?)\s+FROM site_versions\b/.exec(reads[0] ?? "")?.[1]?.split(",").map((column) => column.trim());
    // Exactly what toVersionSummary reads, in any order.
    expect(columns?.sort()).toEqual(["id", "number", "status", "requested_at", "reviewed_at", "review_note"].sort());
  });

  it("lists only the newest 50 versions (moderator decision (1))", async () => {
    const owner = await h.signIn();
    for (let number = 1; number <= 51; number += 1) await seedVersion(owner, number, number);
    const res = await h.call("GET", `/api/sites/${owner.siteId}/versions`, { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const { versions } = await json<{ versions: VersionSummary[] }>(res);
    expect(versions.map((v) => v.number)).toEqual(Array.from({ length: 50 }, (_, i) => 51 - i));
  });
});

describe("POST /api/sites/:siteId/publish-requests", () => {
  it("lists every blocking problem: no slug yet", async () => {
    const owner = await builtOwner(h, VALID_FACTS, VALID_BRIEF);
    const res = await h.call("POST", `/api/sites/${owner.siteId}/publish-requests`, { cookie: owner.cookie, body: { rev: owner.rev } });
    expect(res.status).toBe(422);
    const body = await json<ErrorJson>(res);
    expect(body.error.code).toBe("publish_invalid");
    expect(body.error.issues?.map((i) => i.code)).toEqual(["slug_missing"]);
  });

  it("requires the review attestation when the owner pasted reviews", async () => {
    const facts = { ...VALID_FACTS, testimonials: [{ quote: "Fixed our leak fast.", name: "Ana" }] };
    const owner = await withSlug(await builtOwner(h, facts, VALID_BRIEF), "ana-plumbing");
    const res = await h.call("POST", `/api/sites/${owner.siteId}/publish-requests`, { cookie: owner.cookie, body: { rev: owner.rev } });
    expect((await json<ErrorJson>(res)).error.issues?.map((i) => i.code)).toEqual(["attestation_required"]);
  });

  it("refuses a web address that the blocklist refuses by now (slug_invalid)", async () => {
    const owner = await withSlug(await builtOwner(h, VALID_FACTS, VALID_BRIEF), "was-fine-plumbing");
    // As if the address was accepted before a newer blocklist refused it.
    await (await h.db()).prepare("UPDATE sites SET slug = 'paypal' WHERE id = ?").bind(owner.siteId).run();
    const res = await h.call("POST", `/api/sites/${owner.siteId}/publish-requests`, { cookie: owner.cookie, body: { rev: owner.rev } });
    expect(res.status).toBe(422);
    expect((await json<ErrorJson>(res)).error.issues).toEqual([{ path: ["slug"], code: "slug_invalid", message: "Choose a different web address" }]);
  });

  it(`lists at most the first MAX_ISSUES (${MAX_ISSUES}) blocking problems, in order (P4-3)`, async () => {
    const built = await withSlug(await builtOwner(h, VALID_FACTS, VALID_BRIEF), "many-issues-plumbing");
    // Sixty photos no upload backs (the JSON shape guard allows 64 items): the document's own issues (more
    // than 12 photos) come first, then one photo_ref issue per photo, so the cut falls in the photos.
    const facts = {
      ...VALID_FACTS,
      photos: Array.from({ length: 60 }, (_, i) => ({ url: `https://example.com/photo-${i}.webp`, alt: "A finished job", width: 800, height: 600 })),
    };
    const saved = await h.call("PATCH", `/api/sites/${built.siteId}/draft`, { cookie: built.cookie, body: { rev: built.rev, facts } });
    expect(saved.status).toBe(200);
    const { rev, ai, edits } = await view(built);
    expect(ai).not.toBeNull();
    const composed = SiteDocument.safeParse(composeDocument(facts, { generationId: ai!.generationId, draft: ai!.draft }, edits));
    expect(composed.success).toBe(false);
    const all = [...toIssues(composed.error!), ...photoRefIssues(facts, built.siteId, ROOT, [])];
    expect(all.length).toBeGreaterThan(MAX_ISSUES);

    const res = await h.call("POST", `/api/sites/${built.siteId}/publish-requests`, { cookie: built.cookie, body: { rev } });
    expect(res.status).toBe(422);
    const body = await json<ErrorJson>(res);
    expect(body.error.code).toBe("publish_invalid");
    expect(body.error.issues).toEqual(all.slice(0, MAX_ISSUES));
    expect(await versionCount(built.siteId)).toBe(0);
  });

  it("refuses a stale rev with 409 conflict", async () => {
    const owner = await withSlug(await builtOwner(h, VALID_FACTS, VALID_BRIEF), "stale-rev-plumbing");
    const res = await h.call("POST", `/api/sites/${owner.siteId}/publish-requests`, { cookie: owner.cookie, body: { rev: owner.rev - 1 } });
    expect(res.status).toBe(409);
    expect((await json<ErrorJson>(res)).error).toMatchObject({ code: "conflict", currentRev: owner.rev });
  });

  it("refuses a taken-down site with 423 and stores nothing", async () => {
    const owner = await withSlug(await builtOwner(h, VALID_FACTS, VALID_BRIEF), "offline-plumbing");
    await (await h.db()).prepare("UPDATE sites SET taken_down_at = ? WHERE id = ?").bind(Date.now(), owner.siteId).run();
    const res = await h.call("POST", `/api/sites/${owner.siteId}/publish-requests`, { cookie: owner.cookie, body: { rev: owner.rev } });
    expect(res.status).toBe(423);
    expect((await json<ErrorJson>(res)).error.code).toBe("site_taken_down");
    expect(await versionCount(owner.siteId)).toBe(0);
  });

  it("creates a pending version, alerts the reviewers and shows it on the site", async () => {
    const owner = await withSlug(await builtOwner(h, VALID_FACTS, VALID_BRIEF), "joes-plumbing");
    const res = await h.call("POST", `/api/sites/${owner.siteId}/publish-requests`, { cookie: owner.cookie, body: { rev: owner.rev } });
    expect(res.status).toBe(201);
    const { version } = await json<{ version: VersionSummary }>(res);
    expect(version).toMatchObject({ number: 1, status: "pending", reviewedAt: null, reviewNote: null });
    const after = await view(owner);
    expect(after.inReview).toBe(true);
    expect(after.pendingVersion?.id).toBe(version.id);
    expect((await outbox("reviewer@example.com"))[0]).toMatchObject({ subject: "Website waiting for review: joes-plumbing (version 1)", tag: "admin_alert" });
  });

  // After the test above, which reads the file's first review alert.
  it("publishes pasted reviews once the owner confirms they are from real customers", async () => {
    const facts = { ...VALID_FACTS, testimonials: [{ quote: "Fixed our leak fast.", name: "Ana" }] };
    const owner = await withSlug(await builtOwner(h, facts, { ...VALID_BRIEF, reviewsAreReal: true }), "real-reviews-plumbing");
    const res = await h.call("POST", `/api/sites/${owner.siteId}/publish-requests`, { cookie: owner.cookie, body: { rev: owner.rev } });
    expect(res.status).toBe(201);
    const { version } = await json<{ version: VersionSummary }>(res);
    expect(version).toMatchObject({ number: 1, status: "pending" });
    expect((await view(owner)).pendingVersion?.id).toBe(version.id);
  });

  it("publishing again supersedes the pending version; withdraw clears it", async () => {
    const owner = await withSlug(await builtOwner(h, VALID_FACTS, VALID_BRIEF), "second-try-plumbing");
    const first = await json<{ version: VersionSummary }>(await h.call("POST", `/api/sites/${owner.siteId}/publish-requests`, { cookie: owner.cookie, body: { rev: owner.rev } }));
    const second = await json<{ version: VersionSummary }>(await h.call("POST", `/api/sites/${owner.siteId}/publish-requests`, { cookie: owner.cookie, body: { rev: owner.rev } }));
    expect(second.version.number).toBe(2);
    const list = await json<{ versions: VersionSummary[] }>(await h.call("GET", `/api/sites/${owner.siteId}/versions`, { cookie: owner.cookie }));
    expect(list.versions.map((v) => [v.number, v.status])).toEqual([[2, "pending"], [1, "superseded"]]);
    expect(list.versions[1]?.id).toBe(first.version.id);

    expect((await h.call("DELETE", `/api/sites/${owner.siteId}/publish-requests/pending`, { cookie: owner.cookie })).status).toBe(204);
    const again = await h.call("DELETE", `/api/sites/${owner.siteId}/publish-requests/pending`, { cookie: owner.cookie });
    expect(again.status).toBe(409);
    expect((await json<ErrorJson>(again)).error.code).toBe("nothing_pending");
    expect((await view(owner)).inReview).toBe(false);
  });

  it("answers 404 on another owner's site or version for every publishing route, and changes nothing (§9.1)", async () => {
    const a = await withSlug(await builtOwner(h, VALID_FACTS, VALID_BRIEF), "owner-a-plumbing");
    const b = await h.signIn();
    // B sends A's real rev, so a route that lost its owner filter would really publish.
    const post = await h.call("POST", `/api/sites/${a.siteId}/publish-requests`, { cookie: b.cookie, body: { rev: a.rev } });
    expect(post.status).toBe(404);
    expect((await json<ErrorJson>(post)).error.code).toBe("not_found");
    expect(await versionCount(a.siteId)).toBe(0);

    // A's own request is pending: B can neither withdraw it nor list A's versions.
    const published = await h.call("POST", `/api/sites/${a.siteId}/publish-requests`, { cookie: a.cookie, body: { rev: a.rev } });
    expect(published.status).toBe(201);
    const { version: aVersion } = await json<{ version: VersionSummary }>(published);
    const withdraw = await h.call("DELETE", `/api/sites/${a.siteId}/publish-requests/pending`, { cookie: b.cookie });
    expect(withdraw.status).toBe(404);
    expect((await json<ErrorJson>(withdraw)).error.code).toBe("not_found");
    expect((await view(a)).inReview).toBe(true);
    const list = await h.call("GET", `/api/sites/${a.siteId}/versions`, { cookie: b.cookie });
    expect(list.status).toBe(404);
    expect((await json<ErrorJson>(list)).error.code).toBe("not_found");

    // Nor read A's stored page through B's OWN site: its site check passes, so only the version's site_id stops it.
    const page = await h.call("GET", `/api/sites/${b.siteId}/versions/${aVersion.id}/page`, { cookie: b.cookie });
    expect(page.status).toBe(404);
    expect((await json<ErrorJson>(page)).error.code).toBe("not_found");
  });

  it("refuses more publish requests than Plan 2 allows per site per day with 429 and Retry-After, and alerts the reviewers once", async () => {
    const owner = await withSlug(await builtOwner(h, VALID_FACTS, VALID_BRIEF), "many-tries-plumbing");
    const publish = () => h.call("POST", `/api/sites/${owner.siteId}/publish-requests`, { cookie: owner.cookie, body: { rev: owner.rev } });
    for (let i = 0; i < FAKE_PUBLISH_CAP; i += 1) expect((await publish()).status).toBe(201);
    const refused = await publish();
    expect(refused.status).toBe(429);
    const retryAfter = Number(refused.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(86_400);
    expect(await json<{ error: { code: string; retryAfter: number } }>(refused)).toMatchObject({ error: { code: "rate_limited", retryAfter } });
    // Twenty requests within the hour: one review alert (decision 32), not twenty.
    expect(await alertsFor("many-tries-plumbing")).toEqual([{ subject: "Website waiting for review: many-tries-plumbing (version 1)" }]);
  });

  it("alerts once, from the lowest-numbered request, when two requests of one site commit before either alert check runs (decision 32)", async () => {
    const owner = await withSlug(await builtOwner(h, VALID_FACTS, VALID_BRIEF), "burst-plumbing");
    // Right after the first request's batch, before its alert check, a second request of the site commits (the test
    // Worker's twin): the check then sees both rows, and only the version numbers say which request came first.
    expect((await h.call("POST", "/__test/twin-after-batch", { body: { siteId: owner.siteId } })).status).toBe(200);
    const first = await publishAndSettle(owner);
    expect(first.number).toBe(1);
    expect(await versionCount(owner.siteId)).toBe(2);
    expect(await sentAlerts("burst-plumbing")).toEqual([{ subject: "Website waiting for review: burst-plumbing (version 1)" }]);
    // A later request within the hour sees the earlier ones: no second alert.
    const third = await publishAndSettle(owner);
    expect(third.number).toBe(3);
    expect(await sentAlerts("burst-plumbing")).toEqual([{ subject: "Website waiting for review: burst-plumbing (version 1)" }]);
  });

  it("serves the stored page for the owner with the §7.4 review headers", async () => {
    const owner = await withSlug(await builtOwner(h, VALID_FACTS, VALID_BRIEF), "page-check-plumbing");
    const { version } = await json<{ version: VersionSummary }>(await h.call("POST", `/api/sites/${owner.siteId}/publish-requests`, { cookie: owner.cookie, body: { rev: owner.rev } }));
    const page = await h.call("GET", `/api/sites/${owner.siteId}/versions/${version.id}/page`, { cookie: owner.cookie });
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toBe(
      `sandbox; default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src https://media.${ROOT}; form-action 'none'; frame-ancestors 'self'`,
    );
    expect(page.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain(`action="https://page-check-plumbing.${ROOT}/_f/${owner.siteId}"`);
    const stranger = await h.signIn();
    expect((await h.call("GET", `/api/sites/${owner.siteId}/versions/${version.id}/page`, { cookie: stranger.cookie })).status).toBe(404);
  });

  it("shows 'unpublished changes' once live and the draft differs", async () => {
    const owner = await withSlug(await builtOwner(h, VALID_FACTS, VALID_BRIEF), "live-diff-plumbing");
    const { version } = await json<{ version: VersionSummary }>(await h.call("POST", `/api/sites/${owner.siteId}/publish-requests`, { cookie: owner.cookie, body: { rev: owner.rev } }));
    await h.call("POST", `/__test/versions/${version.id}/approve`, { body: {} });
    const live = await view(owner);
    expect(live).toMatchObject({ live: true, liveUrl: `https://live-diff-plumbing.${ROOT}/`, draftDiffersFromLive: false });
    await h.call("PATCH", `/api/sites/${owner.siteId}/draft`, { cookie: owner.cookie, body: { rev: live.rev, facts: { ...VALID_FACTS, businessName: "Joe's Plumbing & Drains" } } });
    expect((await view(owner)).draftDiffersFromLive).toBe(true);
  });

  it("alerts a site's request when the site's request before it was asked 61 minutes ago: the quiet time is one hour (decision 32)", async () => {
    await startAlertDayAfresh();
    const owner = await withSlug(await builtOwner(h, VALID_FACTS, VALID_BRIEF), "quiet-hour-plumbing");
    await seedVersion(owner, 1, Date.now() - 61 * 60_000);
    expect((await publishAndSettle(owner)).number).toBe(2);
    expect(await sentAlerts("quiet-hour-plumbing")).toEqual([{ subject: "Website waiting for review: quiet-hour-plumbing (version 2)" }]);
  });

  it("sends no alert for a site's request 59 minutes after its request that alerted: the quiet time is a full hour (decision 32)", async () => {
    await startAlertDayAfresh();
    const owner = await withSlug(await builtOwner(h, VALID_FACTS, VALID_BRIEF), "still-quiet-plumbing");
    const first = await publishAndSettle(owner);
    expect(await sentAlerts("still-quiet-plumbing")).toEqual([{ subject: "Website waiting for review: still-quiet-plumbing (version 1)" }]);
    // As if that request, which alerted, was asked 59 minutes before the next one.
    await (await h.db()).prepare("UPDATE site_versions SET requested_at = ? WHERE id = ?").bind(Date.now() - 59 * 60_000, first.id).run();
    expect((await publishAndSettle(owner)).number).toBe(2);
    expect(await sentAlerts("still-quiet-plumbing")).toEqual([{ subject: "Website waiting for review: still-quiet-plumbing (version 1)" }]);
  });

  it("sends no alert for a site's request 60 minutes minus 1 second after its request that alerted: the quiet time is the whole hour (decision 32)", async () => {
    await startAlertDayAfresh();
    const owner = await withSlug(await builtOwner(h, VALID_FACTS, VALID_BRIEF), "last-second-plumbing");
    const first = await publishAndSettle(owner);
    expect(await sentAlerts("last-second-plumbing")).toEqual([{ subject: "Website waiting for review: last-second-plumbing (version 1)" }]);
    // As if that request, which alerted, was asked 60 minutes minus 1 second before the next one.
    const moved = await (await h.db()).prepare("UPDATE site_versions SET requested_at = ? WHERE id = ?").bind(Date.now() - HOUR_MS + 1_000, first.id).run();
    expect(moved.meta.changes).toBe(1);
    expect((await publishAndSettle(owner)).number).toBe(2);
    // The second request was asked within that second: a run slower than 1 s fails here, never passes by accident.
    const asked = (await (await h.db()).prepare("SELECT requested_at FROM site_versions WHERE site_id = ? ORDER BY number").bind(owner.siteId).all<{ requested_at: number }>()).results;
    expect(asked).toHaveLength(2);
    expect(asked[1]!.requested_at - asked[0]!.requested_at).toBeLessThan(HOUR_MS);
    expect(await sentAlerts("last-second-plumbing")).toEqual([{ subject: "Website waiting for review: last-second-plumbing (version 1)" }]);
  });

  // Last of the alert tests: it fills the day's alert allowance for every test after it.
  it("sends the 10th review alert of a UTC day but not the 11th, however many sites ask, counting each request that alerted though a later-committed one of its site was asked earlier (decision 32)", async () => {
    // The day's allowance to this test alone, so the overtaken requests below alert.
    await startAlertDayAfresh();
    // O1 and O2 of security review r3 (task-10-review-sec-r3.md). O3 needs no case of its own (moderator decision,
    // 2026-09-30): it is O2 plus B's own alert check running before A's. B's check is a read-only SELECT, so it leaves
    // exactly O2's rows behind, and it sends nothing (it finds x within B's hour, by version number and by time alike).
    // A's check then reads O2's state, which the O2 case below tests.
    await overtakenRequest("overtaken-late-plumbing", "after A's alert check"); // O1
    await overtakenRequest("overtaken-early-plumbing", "before A's alert check"); // O2
    await awayFromUtcHourEnd();
    const db = await h.db();
    // Today's alert-worthy requests so far, by the route's rule: a site's first request in an hour, by version number.
    // The two overtaken requests count (they alerted); their Bs do not. Ordered by time instead, each B would come
    // before its A, so the day's count would miss two alerts that went out and let an 11th go out.
    const soFar = (await db
      .prepare(
        `SELECT COUNT(*) AS n FROM site_versions v WHERE v.requested_at >= ? AND NOT EXISTS (
           SELECT 1 FROM site_versions w WHERE w.site_id = v.site_id AND w.number < v.number AND w.requested_at > v.requested_at - ?)`,
      )
      .bind(utcDayStart(Date.now()), HOUR_MS)
      .first<{ n: number }>())!.n;
    expect(soFar).toBeLessThanOrEqual(9);
    // Other sites whose first request today already alerted the reviewers, until the day holds nine.
    for (let i = soFar; i < 9; i += 1) await seedVersion(await h.signIn(), 1, Date.now());
    const tenth = await withSlug(await builtOwner(h, VALID_FACTS, VALID_BRIEF), "tenth-plumbing");
    await publishAndSettle(tenth);
    expect(await sentAlerts("tenth-plumbing")).toEqual([{ subject: "Website waiting for review: tenth-plumbing (version 1)" }]);
    const eleventh = await withSlug(await builtOwner(h, VALID_FACTS, VALID_BRIEF), "eleventh-plumbing");
    await publishAndSettle(eleventh);
    expect(await sentAlerts("eleventh-plumbing")).toEqual([]);
  });
});

// Last in this file: its ANALYZE leaves statistics behind, so no other test runs with them. It needs no alert to go
// out (the one above fills the day's allowance): the alert check reads the day's count whether or not it alerts.
describe("the review alert's daily count uses the covering index (P4-21 item 1)", () => {
  /** The query plan of the alert check a publish request ran, one detail line per step. */
  async function alertCheckPlan(sql: string, site: { siteId: string }): Promise<string[]> {
    const now = Date.now();
    const plan = await (await h.db()).prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(site.siteId, now, HOUR_MS, utcDayStart(now), 1).all<{ detail: string }>();
    return plan.results.map((step) => step.detail);
  }

  it("searches site_versions by requested_at through the index, never scanning the table, with and without ANALYZE statistics", async () => {
    const owner = await withSlug(await builtOwner(h, VALID_FACTS, VALID_BRIEF), "index-check-plumbing");
    const path = `/api/sites/${owner.siteId}/publish-requests`;
    await h.recordSql(path);
    await publishAndSettle(owner);
    const checks = (await h.recordedSql(path)).filter((sql) => /\bAS alerts\b/.test(sql));
    expect(checks).toHaveLength(1);
    const covered = "SEARCH v USING COVERING INDEX site_versions_requested (requested_at>?)";
    const withoutStatistics = await alertCheckPlan(checks[0]!, owner);
    expect(withoutStatistics, withoutStatistics.join(" | ")).toContain(covered);
    expect(withoutStatistics.filter((step) => /^SCAN v\b/.test(step))).toEqual([]);
    // D1 advises PRAGMA optimize after creating an index, which runs ANALYZE; the planner must keep the index then too.
    await (await h.db()).prepare("ANALYZE").bind().run();
    const withStatistics = await alertCheckPlan(checks[0]!, owner);
    expect(withStatistics, withStatistics.join(" | ")).toContain(covered);
    expect(withStatistics.filter((step) => /^SCAN v\b/.test(step))).toEqual([]);
  });
});
