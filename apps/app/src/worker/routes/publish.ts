import { adminAlertEmail, ApiError, logLine, MAX_ISSUES, readJson, reviewPageHeaders, slugProblem, storedPageKey, trySend } from "@asksite/app-common";
import { Brief, composeDocument, photoRefIssues, PublishBody, toIssues, type Issue } from "@asksite/core";
import { SiteDocument } from "@asksite/site-schema";
import { Hono } from "hono";
import { assertNotTakenDown, mailerEnv, ownedSite } from "../db.ts";
import type { AppDeps } from "../deps.ts";
import { publishRefusal } from "../publish-refusal.ts";
import { requireOwner } from "../session.ts";
import { currentAi, draftOf, liveUploads, toVersionSummary, type VersionSummaryRow } from "../site-view.ts";
import type { AppEnv } from "../types.ts";
import { storedJsonNote } from "./stored-json-note.ts";

/** A site's publish requests alert the reviewers at most once an hour, and at most ALERTS_PER_DAY alerts go out per UTC day in all (decision 32). */
const ALERT_QUIET_MS = 3_600_000;
const ALERTS_PER_DAY = 10;

/**
 * Whether this request emails the reviewers: it is the site's first request in an hour, and one of
 * the first ALERTS_PER_DAY such requests of the UTC day across all sites. Counted from site_versions,
 * so nothing new is stored. Resend Free's 100 emails a day are shared by every email type (§5.2).
 *
 * The site's count takes only the versions numbered up to this one. Numbers follow commit order (Plan 2
 * assigns MAX + 1 inside its batch, under UNIQUE(site_id, number)), so when two requests of one site both
 * commit before either check runs, the lower-numbered one counts only itself and alerts, and the other
 * sees it and stays quiet, whichever check runs first. Counting every recent row would let both see two.
 * The day's count judges each request by the same rule, so a request that alerted always counts, even when a
 * request of its site that was asked earlier commits after it; by time, that request would drop out of the
 * count and let an 11th alert go out (moderator decision (1), 2026-09-27).
 */
async function shouldAlert(db: D1Database, siteId: string, number: number, now: number): Promise<boolean> {
  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM site_versions WHERE site_id = ?1 AND number <= ?5 AND requested_at > ?2 - ?3) AS recent,
         (SELECT COUNT(*) FROM site_versions v WHERE v.requested_at >= ?4 AND NOT EXISTS (
            SELECT 1 FROM site_versions w
            WHERE w.site_id = v.site_id AND w.number < v.number AND w.requested_at > v.requested_at - ?3)) AS alerts`,
    )
    .bind(siteId, now, ALERT_QUIET_MS, now - (now % 86_400_000), number)
    .first<{ recent: number; alerts: number }>();
  return counts !== null && counts.recent === 1 && counts.alerts <= ALERTS_PER_DAY;
}

/** Publish requests, withdrawals and the owner's view of their versions (§3.1 step 6, §4.4). */
export function publishRoutes(deps: AppDeps): Hono<AppEnv> {
  const publish = new Hono<AppEnv>();

  publish.post("/sites/:siteId/publish-requests", requireOwner, async (c) => {
    const { rev } = await readJson(c, PublishBody);
    const owner = c.get("owner");
    const db = c.env.DB;
    const site = await ownedSite(db, c.req.param("siteId"), owner.id);
    assertNotTakenDown(site);
    if (site.rev !== rev) throw new ApiError("conflict", "This site changed in another tab or window", { currentRev: site.rev });

    const note = storedJsonNote(c);
    const draft = draftOf(site, note);
    const current = await currentAi(db, site.id, note);
    const issues: Issue[] = [];
    let document: SiteDocument | null = null;
    if (current === null) {
      issues.push({ path: ["ai"], code: "not_generated", message: "Build your website before publishing it" });
    } else {
      const parsed = SiteDocument.safeParse(composeDocument(draft.facts, current.ai, draft.edits));
      if (parsed.success) document = parsed.data;
      else issues.push(...toIssues(parsed.error));
    }
    const brief = Brief.safeParse(draft.brief);
    const attested = brief.success && brief.data.reviewsAreReal;
    if (document !== null && document.facts.testimonials.length > 0 && !attested) {
      issues.push({ path: ["brief", "reviewsAreReal"], code: "attestation_required", message: "Confirm that your reviews are from real customers" });
    }
    if (site.slug === null) issues.push({ path: ["slug"], code: "slug_missing", message: "Choose a web address" });
    else if (slugProblem(site.slug) !== null) issues.push({ path: ["slug"], code: "slug_invalid", message: "Choose a different web address" });
    issues.push(...photoRefIssues(draft.facts, site.id, c.env.ROOT_DOMAIN, await liveUploads(db, site.id)));
    if (issues.length > 0 || document === null || site.slug === null || current === null) {
      // Only the first MAX_ISSUES (P4-3): a malformed draft could otherwise list one issue per element.
      throw new ApiError("publish_invalid", "A few things need fixing before this can be published", { issues: issues.slice(0, MAX_ISSUES) });
    }

    const now = Date.now();
    let version;
    try {
      version = await deps.publishing.createPendingVersion(c.env, {
        siteId: site.id,
        ownerId: owner.id,
        slug: site.slug,
        document,
        edits: draft.edits,
        generationId: current.ai.generationId,
        now,
      });
    } catch (err) {
      const refusal = err instanceof deps.publishing.PublishError ? publishRefusal(err.code, err.detail, now) : null;
      throw refusal ?? err;
    }
    const alert = adminAlertEmail({ slug: site.slug, versionNumber: version.number, businessName: document.facts.businessName });
    const recipients = c.env.ADMIN_NOTIFY_EMAILS.split(",").map((a) => a.trim().toLowerCase()).filter((a) => a !== "");
    if (recipients.length > 0) {
      const mailer = deps.createMailer(mailerEnv(c.env));
      // After the response: the version is stored, so a failure here must never look like a failed publish.
      c.executionCtx.waitUntil(
        (async () => {
          if (!(await shouldAlert(db, site.id, version.number, now))) return;
          await Promise.all(recipients.map((to) => trySend(mailer, { to, ...alert, tag: "admin_alert", idempotencyKey: `alert:${version.id}:${to}` })));
        })().catch((err: unknown) => logLine({ event: "alert_failed", error: err instanceof Error ? err.name : "unknown" })),
      );
    }
    return c.json({ version }, 201);
  });

  publish.delete("/sites/:siteId/publish-requests/pending", requireOwner, async (c) => {
    const owner = c.get("owner");
    const site = await ownedSite(c.env.DB, c.req.param("siteId"), owner.id);
    try {
      await deps.publishing.withdrawPending(c.env, { siteId: site.id, ownerId: owner.id, now: Date.now() });
    } catch (err) {
      if (err instanceof deps.publishing.PublishError && err.code === "nothing_pending") {
        throw new ApiError("nothing_pending", "Nothing is waiting for review");
      }
      throw err;
    }
    return c.body(null, 204);
  });

  publish.get("/sites/:siteId/versions", requireOwner, async (c) => {
    const site = await ownedSite(c.env.DB, c.req.param("siteId"), c.get("owner").id);
    // The newest 50 only (moderator decision (1)), and only the columns a summary shows: never a version's stored
    // document or edits, which can be hundreds of KB each (m2).
    const { results } = await c.env.DB.prepare(
      "SELECT id, number, status, requested_at, reviewed_at, review_note FROM site_versions WHERE site_id = ? ORDER BY number DESC LIMIT 50",
    )
      .bind(site.id)
      .all<VersionSummaryRow>();
    return c.json({ versions: results.map(toVersionSummary) });
  });

  // One page of a stored version, for the "See what we are reviewing" preview. The site must be the owner's and the version
  // that site's (another owner's version is 404, never 403); storedPageKey does the rest: a page id of the five that the
  // version lists, its key from versionPageKey. Anything else is the same 404.
  publish.get("/sites/:siteId/versions/:versionId/pages/:pageId", requireOwner, async (c) => {
    const site = await ownedSite(c.env.DB, c.req.param("siteId"), c.get("owner").id);
    const version = await c.env.DB.prepare("SELECT id, site_id, pages_json FROM site_versions WHERE id = ? AND site_id = ?")
      .bind(c.req.param("versionId"), site.id)
      .first<{ id: string; site_id: string; pages_json: string }>();
    const key = version === null ? null : storedPageKey(version, c.req.param("pageId"));
    const object = key === null ? null : await c.env.WORK.get(key);
    if (object === null) throw new ApiError("not_found", "Not found");
    return new Response(object.body, { headers: reviewPageHeaders(c.env.ROOT_DOMAIN) });
  });

  return publish;
}
