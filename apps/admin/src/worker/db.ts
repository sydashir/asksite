import { ApiError } from "@asksite/app-common";
import { isId, type AdminSiteRow, type SiteVersionRow, type VersionSummary } from "@asksite/core";
import type { MailerEnv } from "./deps.ts";

/** A sites row joined with its owner, as the admin lists it. */
export interface SiteWithOwner {
  id: string;
  owner_id: string;
  slug: string | null;
  facts_json: string;
  brief_json: string;
  live_version_id: string | null;
  pending_version_id: string | null;
  indexable: 0 | 1;
  taken_down_at: number | null;
  created_at: number;
  updated_at: number;
  owner_email: string;
  owner_disabled_at: number | null;
}

export const SITE_WITH_OWNER = `SELECT s.id, s.owner_id, s.slug, s.facts_json, s.brief_json, s.live_version_id, s.pending_version_id,
  s.indexable, s.taken_down_at, s.created_at, s.updated_at, o.email AS owner_email, o.disabled_at AS owner_disabled_at
  FROM sites s JOIN owners o ON o.id = s.owner_id`;

function businessName(factsJson: string): string | null {
  try {
    const name = (JSON.parse(factsJson) as { businessName?: unknown }).businessName;
    return typeof name === "string" && name.trim() !== "" ? name : null;
  } catch {
    return null;
  }
}

export function toAdminSiteRow(site: SiteWithOwner): AdminSiteRow {
  return {
    id: site.id,
    slug: site.slug,
    businessName: businessName(site.facts_json),
    live: site.live_version_id !== null && site.taken_down_at === null,
    inReview: site.pending_version_id !== null,
    takenDown: site.taken_down_at !== null,
    ownerId: site.owner_id,
    ownerEmail: site.owner_email,
    ownerDisabled: site.owner_disabled_at !== null,
    indexable: site.indexable === 1,
    createdAt: site.created_at,
    updatedAt: site.updated_at,
  };
}

export function toVersionSummary(row: Pick<SiteVersionRow, "id" | "number" | "status" | "requested_at" | "reviewed_at" | "review_note">): VersionSummary {
  return { id: row.id, number: row.number, status: row.status, requestedAt: row.requested_at, reviewedAt: row.reviewed_at, reviewNote: row.review_note };
}

export async function siteWithOwner(db: D1Database, siteId: string): Promise<SiteWithOwner> {
  const site = isId(siteId) ? await db.prepare(`${SITE_WITH_OWNER} WHERE s.id = ?`).bind(siteId).first<SiteWithOwner>() : null;
  if (site === null) throw new ApiError("not_found", "Not found");
  return site;
}

export async function versionRow(db: D1Database, versionId: string): Promise<SiteVersionRow> {
  const version = isId(versionId) ? await db.prepare("SELECT * FROM site_versions WHERE id = ?").bind(versionId).first<SiteVersionRow>() : null;
  if (version === null) throw new ApiError("not_found", "Not found");
  return version;
}

export function mailerEnv(env: Env): MailerEnv {
  if (env.MAILER !== "resend" && env.MAILER !== "log") throw new Error("MAILER must be resend or log");
  return { MAILER: env.MAILER, MAIL_FROM: env.MAIL_FROM, RESEND_API_KEY: env.RESEND_API_KEY, DB: env.DB, ENVIRONMENT: env.ENVIRONMENT };
}

export const utcDayStart = (now: number): number => {
  const day = new Date(now);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
};
