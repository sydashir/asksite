import type { Mailer } from "@asksite/app-common";
import { liveKey, sha256Hex, siteUrl, versionKey, type SiteVersionRow } from "@asksite/core";
import { FakePublishError, fakeCreateMailer, toGenerationView } from "../../../app/test/support/fakes.ts";
import type { AdminDeps, AdminGenerationDeps, AdminPublishingDeps, MailerEnv } from "../../src/worker/deps.ts";

// Test stand-ins for the Plan 2 functions the admin calls (§7.2), following the documented steps
// closely enough for this Worker's tests. The integration task swaps in @asksite/publishing.

const audit = (db: D1Database, at: number, reviewer: string, action: string, siteId: string, detail: Record<string, unknown> = {}) =>
  db.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (?, ?, ?, ?, ?)").bind(at, `admin:${reviewer}`, action, siteId, JSON.stringify(detail));

async function storedBytes(work: R2Bucket, key: string): Promise<string | null> {
  const object = await work.get(key);
  return object === null ? null : object.text();
}

export const fakeAdminPublishing: AdminPublishingDeps = {
  PublishError: FakePublishError,
  async approveVersion(env, input) {
    const version = await env.DB.prepare("SELECT v.*, s.slug FROM site_versions v JOIN sites s ON s.id = v.site_id WHERE v.id = ?")
      .bind(input.versionId)
      .first<SiteVersionRow & { slug: string }>();
    if (version === null) throw new FakePublishError("version_not_pending");
    const html = await storedBytes(env.WORK, versionKey(version.site_id, version.id));
    if (input.htmlSha256 !== version.html_sha256 || html === null || (await sha256Hex(html)) !== version.html_sha256) throw new FakePublishError("integrity");
    const [site] = await env.DB.batch([
      env.DB.prepare("UPDATE sites SET live_version_id = ?, pending_version_id = NULL, indexable = ?, updated_at = ? WHERE id = ? AND pending_version_id = ? AND taken_down_at IS NULL")
        .bind(version.id, input.indexable ? 1 : 0, input.now, version.site_id, version.id),
      env.DB.prepare("UPDATE site_versions SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM sites WHERE id = ? AND live_version_id = ?)")
        .bind(input.reviewer, input.now, input.note, version.id, version.site_id, version.id),
      audit(env.DB, input.now, input.reviewer, "version.approved", version.site_id, { versionId: version.id }),
    ]);
    if (site?.meta.changes !== 1) {
      const now = await env.DB.prepare("SELECT live_version_id, taken_down_at FROM sites WHERE id = ?").bind(version.site_id).first<{ live_version_id: string | null; taken_down_at: number | null }>();
      if (now?.taken_down_at !== null) throw new FakePublishError("site_taken_down");
      if (now.live_version_id !== version.id) throw new FakePublishError("version_not_pending");
    }
    await env.LIVE.put(liveKey(version.slug), html, { httpMetadata: { contentType: "text/html; charset=utf-8" }, customMetadata: { siteId: version.site_id, versionId: version.id, sha256: version.html_sha256 } });
    return { siteId: version.site_id, slug: version.slug, liveUrl: siteUrl(env.ROOT_DOMAIN, version.slug) };
  },
  async rejectVersion(env, input) {
    const version = await env.DB.prepare("SELECT site_id FROM site_versions WHERE id = ? AND status = 'pending'").bind(input.versionId).first<{ site_id: string }>();
    if (version === null) throw new FakePublishError("version_not_pending");
    await env.DB.batch([
      env.DB.prepare("UPDATE site_versions SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?").bind(input.reviewer, input.now, input.note, input.versionId),
      env.DB.prepare("UPDATE sites SET pending_version_id = NULL, updated_at = ? WHERE id = ? AND pending_version_id = ?").bind(input.now, version.site_id, input.versionId),
      audit(env.DB, input.now, input.reviewer, "version.rejected", version.site_id, { versionId: input.versionId }),
    ]);
    return { siteId: version.site_id };
  },
  async takeDown(env, input) {
    const site = await env.DB.prepare("SELECT slug, pending_version_id FROM sites WHERE id = ?").bind(input.siteId).first<{ slug: string | null; pending_version_id: string | null }>();
    if (site === null) throw new FakePublishError("site_not_found");
    await env.DB.batch([
      env.DB.prepare("UPDATE site_versions SET status = 'rejected', review_note = 'Site taken down' WHERE site_id = ? AND status = 'pending'").bind(input.siteId),
      env.DB.prepare("UPDATE sites SET taken_down_at = COALESCE(taken_down_at, ?), takedown_reason = ?, pending_version_id = NULL WHERE id = ?").bind(input.now, input.reason, input.siteId),
      audit(env.DB, input.now, input.reviewer, "site.taken_down", input.siteId, { reason: input.reason, purgeMedia: input.purgeMedia }),
    ]);
    if (site?.slug) await env.LIVE.delete(liveKey(site.slug));
    if (input.purgeMedia) {
      const listed = await env.MEDIA.list({ prefix: `${input.siteId}/` });
      await Promise.all(listed.objects.map((o) => env.MEDIA.delete(o.key)));
      await env.DB.prepare("UPDATE uploads SET deleted_at = COALESCE(deleted_at, ?) WHERE site_id = ?").bind(input.now, input.siteId).run();
    }
  },
  async restore(env, input) {
    const site = await env.DB.prepare("SELECT s.slug, v.id, v.html_sha256, v.document_json FROM sites s LEFT JOIN site_versions v ON v.id = s.live_version_id WHERE s.id = ?")
      .bind(input.siteId)
      .first<{ slug: string; id: string | null; html_sha256: string | null; document_json: string | null }>();
    if (site === null) throw new FakePublishError("site_not_found");
    if (site.id === null || site.document_json === null) throw new FakePublishError("not_live");
    const html = await storedBytes(env.WORK, versionKey(input.siteId, site.id));
    if (html === null || (await sha256Hex(html)) !== site.html_sha256) throw new FakePublishError("integrity");
    await env.LIVE.put(liveKey(site.slug), html);
    await env.DB.batch([
      env.DB.prepare("UPDATE sites SET taken_down_at = NULL, takedown_reason = NULL WHERE id = ?").bind(input.siteId),
      audit(env.DB, input.now, input.reviewer, "site.restored", input.siteId),
    ]);
    // As Plan 2 decision 29: count the page's photos that a takedown with purgeMedia deleted.
    const { facts } = JSON.parse(site.document_json) as { facts: { heroPhoto?: { url: string }; photos?: Array<{ url: string }> } };
    const prefix = `https://media.${env.ROOT_DOMAIN}/`;
    const keys = [facts.heroPhoto, ...(facts.photos ?? [])].flatMap((p) => (p !== undefined && p.url.startsWith(prefix) ? [p.url.slice(prefix.length)] : []));
    const missingPhotos = (await Promise.all(keys.map((key) => env.MEDIA.head(key)))).filter((o) => o === null).length;
    return { liveUrl: siteUrl(env.ROOT_DOMAIN, site.slug), missingPhotos };
  },
  async setIndexable(env, input) {
    const site = await env.DB.prepare("SELECT 1 AS found FROM sites WHERE id = ?").bind(input.siteId).first();
    if (site === null) throw new FakePublishError("site_not_found");
    await env.DB.batch([
      env.DB.prepare("UPDATE sites SET indexable = ? WHERE id = ?").bind(input.indexable ? 1 : 0, input.siteId),
      audit(env.DB, input.now, input.reviewer, "site.indexable_changed", input.siteId, { indexable: input.indexable }),
    ]);
  },
};

/**
 * Plan 3's settings helpers, as §6.4 describes them. The worst case is a fixed test figure, and null
 * (no recorded price, Plan 3 decision 11) for the model id "unpriced-model".
 */
export const fakeAdminGeneration: AdminGenerationDeps = {
  async dailyModelLimit(env) {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'generation.daily_model_limit'").first<{ value: string }>();
    return Number(row?.value ?? env.DAILY_MODEL_LIMIT);
  },
  worstCaseJobMicrousd: (_provider, modelId) => (modelId === "unpriced-model" ? null : 336_000),
  toGenerationView,
};

/**
 * The app's fake mailer (an address at @mail-fails.example fails as Plan 2's MailerError "rejected"), plus
 * the admin's own case: an address at @mail-rate-limited.example fails as "rate_limited", the shared daily
 * Resend limit (§7.6), which the invite route explains to the admin in its own words.
 */
export function fakeAdminCreateMailer(env: MailerEnv): Mailer {
  const mailer = fakeCreateMailer(env);
  return {
    async send(email) {
      if (email.to.endsWith("@mail-rate-limited.example")) throw Object.assign(new Error("rate_limited"), { name: "MailerError", code: "rate_limited" });
      return mailer.send(email);
    },
  };
}

export const fakeAdminDeps: AdminDeps = { publishing: fakeAdminPublishing, generation: fakeAdminGeneration, createMailer: fakeAdminCreateMailer };
