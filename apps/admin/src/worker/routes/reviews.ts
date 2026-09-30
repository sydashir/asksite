import { ApiError, readJson, reviewApprovedEmail, reviewRejectedEmail, reviewPageHeaders, trySend } from "@asksite/app-common";
import { ApproveBody, RejectBody, type AdminVersionDetail, type GenerationRow, type SiteVersionRow } from "@asksite/core";
import { Hono } from "hono";
import { mailerEnv, siteWithOwner, toAdminSiteRow, toVersionSummary, versionRow, type AdminSiteColumns } from "../db.ts";
import type { AdminDeps, PublishErrorLike } from "../deps.ts";
import { publishApiError } from "../publish-errors.ts";
import { REVIEW_QUEUE } from "../queries.ts";
import { editedPaths, reviewChecks, storedDocument } from "../review-checks.ts";
import type { AdminEnv } from "../types.ts";

type QueueRow = AdminSiteColumns & {
  v_id: string;
  v_number: number;
  v_status: "pending";
  v_requested_at: number;
  v_reviewed_at: number | null;
  v_review_note: string | null;
};

/** Review queue, the version under review, and approve / reject (§3.2 step 3, §4.5). */
export function reviewRoutes(deps: AdminDeps): Hono<AdminEnv> {
  const reviews = new Hono<AdminEnv>();

  const publishError = (err: unknown): ApiError | null =>
    err instanceof deps.publishing.PublishError ? publishApiError((err as PublishErrorLike).code, "review") : null;

  /**
   * The owner email's mailer and APP_ORIGIN, checked before approve or reject changes anything, so a configuration
   * error (MAILER, APP_ORIGIN) is a 500 that leaves the version pending (moderator ruling, 2026-09-30). The email
   * itself is built after the change, which gives the live address. app-common applies its origin rule only inside
   * its email builders, so building one here (and dropping it) checks APP_ORIGIN by that exact rule.
   */
  const ownerMail = (env: Env) => {
    const mailer = deps.createMailer(mailerEnv(env));
    reviewRejectedEmail({ appOrigin: env.APP_ORIGIN, note: "" });
    return { mailer, appOrigin: env.APP_ORIGIN };
  };

  const emailOwner = async (env: Env, siteId: string, send: (to: string) => Promise<unknown>) => {
    const owner = await env.DB.prepare("SELECT o.email FROM sites s JOIN owners o ON o.id = s.owner_id WHERE s.id = ?").bind(siteId).first<{ email: string }>();
    if (owner !== null) await send(owner.email);
  };

  reviews.get("/reviews", async (c) => {
    const { results } = await c.env.DB.prepare(REVIEW_QUEUE).all<QueueRow>();
    return c.json({
      items: results.map((row) => ({
        version: toVersionSummary({ id: row.v_id, number: row.v_number, status: row.v_status, requested_at: row.v_requested_at, reviewed_at: row.v_reviewed_at, review_note: row.v_review_note }),
        site: toAdminSiteRow(row),
      })),
    });
  });

  reviews.get("/versions/:versionId", async (c) => {
    const db = c.env.DB;
    const version = await versionRow(db, c.req.param("versionId"));
    const site = await siteWithOwner(db, version.site_id);
    const generation = version.generation_id === null ? null : await db.prepare("SELECT * FROM generations WHERE id = ?").bind(version.generation_id).first<GenerationRow>();
    const live = site.live_version_id !== null && site.live_version_id !== version.id ? await versionRow(db, site.live_version_id) : null;
    const document = storedDocument(version.document_json);
    const detail: AdminVersionDetail = {
      version: { ...toVersionSummary(version), siteId: version.site_id, htmlSha256: version.html_sha256, generationId: version.generation_id, requestedBy: version.requested_by },
      site: toAdminSiteRow(site),
      document,
      ownerEditedPaths: editedPaths(version, generation?.output_json ?? null),
      liveDocument: live === null ? null : storedDocument(live.document_json),
      checks: reviewChecks({ site, document, usedFallback: generation?.used_fallback === 1 }),
      pageUrl: `/api/admin/versions/${version.id}/page`,
    };
    return c.json(detail);
  });

  reviews.get("/versions/:versionId/page", async (c) => {
    const version = await versionRow(c.env.DB, c.req.param("versionId"));
    const object = await c.env.WORK.get(version.html_key);
    if (object === null) throw new ApiError("not_found", "Not found");
    return new Response(object.body, { headers: reviewPageHeaders(c.env.ROOT_DOMAIN) });
  });

  reviews.post("/versions/:versionId/approve", async (c) => {
    const body = await readJson(c, ApproveBody);
    const version: SiteVersionRow = await versionRow(c.env.DB, c.req.param("versionId"));
    const { mailer, appOrigin } = ownerMail(c.env);
    let result;
    try {
      result = await deps.publishing.approveVersion(c.env, {
        versionId: version.id,
        htmlSha256: body.htmlSha256,
        reviewer: c.get("admin"),
        note: body.note === undefined || body.note === "" ? null : body.note,
        indexable: body.indexable,
        now: Date.now(),
      });
    } catch (err) {
      throw publishError(err) ?? err;
    }
    const email = reviewApprovedEmail({ appOrigin, liveUrl: result.liveUrl });
    c.executionCtx.waitUntil(emailOwner(c.env, result.siteId, (to) => trySend(mailer, { to, ...email, tag: "review_result", idempotencyKey: `review:${version.id}` })));
    return c.json({ siteId: result.siteId, liveUrl: result.liveUrl });
  });

  reviews.post("/versions/:versionId/reject", async (c) => {
    const { note } = await readJson(c, RejectBody);
    const version = await versionRow(c.env.DB, c.req.param("versionId"));
    const { mailer, appOrigin } = ownerMail(c.env);
    let result;
    try {
      result = await deps.publishing.rejectVersion(c.env, { versionId: version.id, reviewer: c.get("admin"), note, now: Date.now() });
    } catch (err) {
      throw publishError(err) ?? err;
    }
    const email = reviewRejectedEmail({ appOrigin, note });
    c.executionCtx.waitUntil(emailOwner(c.env, result.siteId, (to) => trySend(mailer, { to, ...email, tag: "review_result", idempotencyKey: `review:${version.id}` })));
    return c.json({ siteId: result.siteId });
  });

  return reviews;
}
