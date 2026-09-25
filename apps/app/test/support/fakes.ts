import type { Mailer } from "@asksite/app-common";
import {
  formActionUrl,
  newId,
  sha256Hex,
  canonicalJson,
  versionKey,
  type AiDraft,
  type FallbackReason,
  type GenerationErrorCode,
  type GenerationRow,
  type GenerationView,
  type VersionSummary,
  LIMITS,
  liveKey,
  siteUrl,
} from "@asksite/core";
import { render } from "@asksite/renderer";
import { SITE_CSS } from "@asksite/site-css";
import { factSections, SECTION_VARIANTS, type Facts, type LayoutSection, type SectionId } from "@asksite/site-schema";
import type { GenerationDeps, MailerEnv, PublishErrorCode, PublishingDeps } from "../../src/worker/deps.ts";
import { FAKE_PUBLISH_CAP } from "./limits.ts";

// Test stand-ins for Plan 2 (@asksite/publishing, @asksite/mailer) and Plan 3 (@asksite/generation).
// Each follows the design's contract (§6.4, §7.2, §7.6) closely enough for this Worker's tests;
// none of them is ever deployed. The integration task swaps in the real packages.

const TRADE_WORD: Record<Facts["trade"], string> = {
  plumbing: "Plumbing",
  hvac: "Heating and cooling",
  electrical: "Electrical work",
  roofing: "Roofing",
  cleaning: "Cleaning",
  landscaping: "Landscaping",
};

/** A draft that passes SiteDocument for any valid facts: no claims, no numbers, every fact section listed. */
export function fakeAiDraft(facts: Facts): AiDraft {
  const sections: SectionId[] = ["hero", ...factSections(facts).filter((id) => id !== "contact"), "about", "faq", "contact"];
  const layout = sections.map((id) => ({ id, variant: SECTION_VARIANTS[id][0] }) as LayoutSection);
  return {
    copy: {
      heroHeadline: `${TRADE_WORD[facts.trade]} done right`,
      heroSubheadline: "Careful, tidy work from a local team you can reach.",
      ctaText: "Request a quote",
      about: "We are a local business that cares about doing the job properly and treating your home with respect.",
      sectionIntros: { services: "Here is what we can help you with.", contact: "Tell us what you need and we will get back to you." },
      serviceDescriptions: facts.services.map((s) => ({ service: s.name, description: "Done carefully by our team." })),
      faq: [{ question: "Do you clean up after the job?", answer: "Yes. We leave your home as tidy as we found it." }],
    },
    layout,
    theme: { palette: "navy-orange", font: "clean" },
  };
}

const utcDayStart = (now: number): number => Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());

export function toGenerationView(row: GenerationRow): GenerationView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code as GenerationErrorCode | null,
    usedFallback: row.used_fallback === 1,
    fallbackReason: row.fallback_reason as FallbackReason | null,
  };
}

export const fakeGeneration: GenerationDeps = {
  async requestGeneration(env, input) {
    const db = env.DB;
    const done = await db.prepare("SELECT 1 FROM generations WHERE site_id = ? AND status = 'succeeded' LIMIT 1").bind(input.siteId).first();
    const kind = done === null ? "first" : "regenerate";
    if (kind === "regenerate" && env.GENERATION_ENABLED !== "true") return { ok: false, code: "generation_disabled" };
    const id = newId();
    try {
      // Only regenerations count toward, and meet, the owner's lifetime cap (decision 40).
      const inserted = await db
        .prepare(
          `INSERT INTO generations (id, site_id, owner_id, kind, status, input_json, created_at)
           SELECT ?1, ?2, ?3, ?4, 'queued', ?5, ?6
           WHERE (SELECT COUNT(*) FROM generations WHERE site_id = ?2 AND created_at >= ?7) < ?8
             AND (?4 = 'first' OR (SELECT COUNT(*) FROM generations WHERE owner_id = ?3 AND kind = 'regenerate') < ?9)`,
        )
        .bind(id, input.siteId, input.ownerId, kind, JSON.stringify(input.snapshot), input.now, utcDayStart(input.now), LIMITS.generationsPerSitePerDay, LIMITS.generationsPerOwnerTotal)
        .run();
      if (inserted.meta.changes !== 1) return { ok: false, code: "generation_cap_reached" };
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) return { ok: false, code: "generation_in_progress" };
      throw err;
    }
    await env.GEN_QUEUE.send({ v: 1, generationId: id });
    const row = await db.prepare("SELECT * FROM generations WHERE id = ?").bind(id).first<GenerationRow>();
    if (row === null) return { ok: false, code: "internal" };
    return { ok: true, generation: toGenerationView(row) };
  },
  async generationAllowance(env, input) {
    const counts = await env.DB.prepare(
      "SELECT COUNT(*) FILTER (WHERE site_id = ?1 AND created_at >= ?3) AS today, COUNT(*) FILTER (WHERE kind = 'regenerate') AS total FROM generations WHERE owner_id = ?2",
    )
      .bind(input.siteId, input.ownerId, utcDayStart(input.now))
      .first<{ today: number; total: number }>();
    return {
      generationsLeftToday: Math.max(0, LIMITS.generationsPerSitePerDay - (counts?.today ?? 0)),
      generationsLeftTotal: Math.max(0, LIMITS.generationsPerOwnerTotal - (counts?.total ?? 0)),
    };
  },
  toGenerationView,
};

/** What the real generator does at the end of a job (§6.3 step 4), driven by tests. */
export async function finishGeneration(
  db: D1Database,
  generationId: string,
  outcome: { status: "succeeded"; usedFallback?: boolean } | { status: "failed"; errorCode: GenerationErrorCode },
  now: number,
): Promise<boolean> {
  const row = await db.prepare("SELECT * FROM generations WHERE id = ? AND status IN ('queued', 'running')").bind(generationId).first<GenerationRow>();
  if (row === null) return false;
  if (outcome.status === "failed") {
    await db.prepare("UPDATE generations SET status = 'failed', error_code = ?, finished_at = ? WHERE id = ?").bind(outcome.errorCode, now, generationId).run();
    return true;
  }
  const { facts } = JSON.parse(row.input_json) as { facts: Facts };
  await db
    .prepare("UPDATE generations SET status = 'succeeded', output_json = ?, used_fallback = ?, fallback_reason = ?, finished_at = ? WHERE id = ?")
    .bind(JSON.stringify(fakeAiDraft(facts)), outcome.usedFallback ? 1 : 0, outcome.usedFallback ? "disabled" : null, now, generationId)
    .run();
  return true;
}

export class FakePublishError extends Error {
  readonly code: PublishErrorCode;
  readonly detail: unknown;

  constructor(code: PublishErrorCode, detail?: unknown) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

const audit = (db: D1Database, at: number, actor: string, action: string, siteId: string, detail: Record<string, unknown> = {}) =>
  db.prepare("INSERT INTO audit_log (at, actor, action, site_id, detail_json) VALUES (?, ?, ?, ?, ?)").bind(at, actor, action, siteId, JSON.stringify(detail));

export const fakePublishing: PublishingDeps = {
  PublishError: FakePublishError,
  async createPendingVersion(env, input) {
    const dayStart = input.now - (input.now % 86_400_000);
    const today = await env.DB.prepare("SELECT COUNT(*) AS n FROM site_versions WHERE site_id = ? AND requested_at >= ?").bind(input.siteId, dayStart).first<{ n: number }>();
    if ((today?.n ?? 0) >= FAKE_PUBLISH_CAP) throw new FakePublishError("publish_cap_reached", { retryAfter: Math.ceil((dayStart + 86_400_000 - input.now) / 1000) });
    const html = render(input.document, { stylesheet: SITE_CSS, formAction: formActionUrl(env.ROOT_DOMAIN, input.slug, input.siteId) });
    const id = newId();
    const htmlSha256 = await sha256Hex(html);
    await env.WORK.put(versionKey(input.siteId, id), html, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
      customMetadata: { siteId: input.siteId, versionId: id, sha256: htmlSha256 },
    });
    const documentJson = canonicalJson(input.document);
    const last = await env.DB.prepare("SELECT MAX(number) AS n FROM site_versions WHERE site_id = ?").bind(input.siteId).first<{ n: number | null }>();
    const number = (last?.n ?? 0) + 1;
    await env.DB.batch([
      env.DB.prepare("UPDATE site_versions SET status = 'superseded' WHERE site_id = ? AND status = 'pending'").bind(input.siteId),
      env.DB.prepare(
        `INSERT INTO site_versions (id, site_id, number, status, document_json, document_sha256, edits_json, generation_id,
           html_key, html_sha256, stylesheet_sha256, requested_by, requested_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, input.siteId, number, documentJson, await sha256Hex(documentJson), JSON.stringify(input.edits), input.generationId,
        versionKey(input.siteId, id), htmlSha256, await sha256Hex(SITE_CSS), input.ownerId, input.now),
      env.DB.prepare("UPDATE sites SET pending_version_id = ?, updated_at = ? WHERE id = ?").bind(id, input.now, input.siteId),
      audit(env.DB, input.now, `owner:${input.ownerId}`, "version.requested", input.siteId, { versionId: id }),
    ]);
    const summary: VersionSummary = { id, number, status: "pending", requestedAt: input.now, reviewedAt: null, reviewNote: null };
    return summary;
  },
  async withdrawPending(env, input) {
    const site = await env.DB.prepare("SELECT pending_version_id FROM sites WHERE id = ? AND owner_id = ?")
      .bind(input.siteId, input.ownerId)
      .first<{ pending_version_id: string | null }>();
    if (site === null || site.pending_version_id === null) throw new FakePublishError("nothing_pending");
    await env.DB.batch([
      env.DB.prepare("UPDATE site_versions SET status = 'withdrawn' WHERE id = ? AND status = 'pending'").bind(site.pending_version_id),
      env.DB.prepare("UPDATE sites SET pending_version_id = NULL, updated_at = ? WHERE id = ?").bind(input.now, input.siteId),
      audit(env.DB, input.now, `owner:${input.ownerId}`, "version.withdrawn", input.siteId, { versionId: site.pending_version_id }),
    ]);
  },
};

/** Approve without checks (tests only): make a pending version live, as §7.2 approveVersion would. */
export async function fakeApprove(env: { DB: D1Database; WORK: R2Bucket; ROOT_DOMAIN: string }, versionId: string, now: number) {
  const version = await env.DB.prepare("SELECT v.site_id, s.slug FROM site_versions v JOIN sites s ON s.id = v.site_id WHERE v.id = ?")
    .bind(versionId)
    .first<{ site_id: string; slug: string }>();
  if (version === null) throw new FakePublishError("version_not_pending");
  await env.DB.batch([
    env.DB.prepare("UPDATE sites SET live_version_id = ?, pending_version_id = NULL, updated_at = ? WHERE id = ?").bind(versionId, now, version.site_id),
    env.DB.prepare("UPDATE site_versions SET status = 'approved', reviewed_by = 'admin@example.com', reviewed_at = ? WHERE id = ?").bind(now, versionId),
  ]);
  return { siteId: version.site_id, liveKey: liveKey(version.slug), liveUrl: siteUrl(env.ROOT_DOMAIN, version.slug) };
}

/** Writes to dev_outbox like Plan 2's log mailer. Addresses at mail-fails.example fail like a rejected send. */
export function fakeCreateMailer(env: MailerEnv): Mailer {
  return {
    async send(email) {
      if (email.to.endsWith("@mail-fails.example")) {
        throw Object.assign(new Error("rejected"), { name: "MailerError", code: "rejected" });
      }
      await env.DB.prepare("INSERT INTO dev_outbox (at, to_addr, subject, text, tag) VALUES (?, ?, ?, ?, ?)")
        .bind(Date.now(), email.to, email.subject, email.text, email.tag)
        .run();
      return { id: newId() };
    },
  };
}
