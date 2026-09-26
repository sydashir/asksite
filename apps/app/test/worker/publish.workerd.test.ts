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

  it("serves the stored page for the owner with the §7.4 review headers", async () => {
    const owner = await withSlug(await builtOwner(h, VALID_FACTS, VALID_BRIEF), "page-check-plumbing");
    const { version } = await json<{ version: VersionSummary }>(await h.call("POST", `/api/sites/${owner.siteId}/publish-requests`, { cookie: owner.cookie, body: { rev: owner.rev } }));
    const page = await h.call("GET", `/api/sites/${owner.siteId}/versions/${version.id}/page`, { cookie: owner.cookie });
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toBe(
      `sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src https://media.${ROOT}; form-action 'none'; frame-ancestors 'self'`,
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

  // Last in this file: it fills the day's alert allowance for every test after it.
  it("sends the 10th review alert of a UTC day but not the 11th, however many sites ask (decision 32)", async () => {
    await awayFromUtcHourEnd();
    const db = await h.db();
    // Today's alert-worthy requests so far, by the route's rule: a site's first request in an hour (the rows
    // dated 1970 above count for nothing). The tests before this one make fewer than nine.
    const soFar = (await db
      .prepare(
        `SELECT COUNT(*) AS n FROM site_versions v WHERE v.requested_at >= ? AND NOT EXISTS (
           SELECT 1 FROM site_versions w WHERE w.site_id = v.site_id AND w.requested_at < v.requested_at AND w.requested_at > v.requested_at - 3600000)`,
      )
      .bind(utcDayStart(Date.now()))
      .first<{ n: number }>())!.n;
    expect(soFar).toBeLessThanOrEqual(9);
    // Other sites whose first request today already alerted the reviewers, until the day holds nine.
    for (let i = soFar; i < 9; i += 1) {
      const other = await h.signIn();
      await db
        .prepare(
          `INSERT INTO site_versions (id, site_id, number, status, document_json, document_sha256, edits_json, html_key, html_sha256,
             stylesheet_sha256, requested_by, requested_at)
           VALUES (?, ?, 1, 'superseded', '{}', 'x', '{}', 'x', 'x', 'x', ?, ?)`,
        )
        .bind(crypto.randomUUID(), other.siteId, other.ownerId, Date.now())
        .run();
    }
    const tenth = await withSlug(await builtOwner(h, VALID_FACTS, VALID_BRIEF), "tenth-plumbing");
    await publishAndSettle(tenth);
    expect(await sentAlerts("tenth-plumbing")).toEqual([{ subject: "Website waiting for review: tenth-plumbing (version 1)" }]);
    const eleventh = await withSlug(await builtOwner(h, VALID_FACTS, VALID_BRIEF), "eleventh-plumbing");
    await publishAndSettle(eleventh);
    expect(await sentAlerts("eleventh-plumbing")).toEqual([]);
  });
});
