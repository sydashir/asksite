import type { PageId } from "@asksite/site-schema";
import type { AiDraft, OwnerEdits } from "./draft.ts";
import type { FallbackReason, GenerationErrorCode } from "./generation.ts";
import type { Issue } from "./issues.ts";

// Response shapes of the owner and admin APIs (design §4.2).

export interface OwnerView { id: string; email: string }
export interface SiteSummary { id: string; slug: string | null; businessName: string | null; live: boolean; inReview: boolean; takenDown: boolean }
export interface GenerationView {
  id: string; kind: "first" | "regenerate"; status: "queued" | "running" | "succeeded" | "failed";
  createdAt: number; finishedAt: number | null; errorCode: GenerationErrorCode | null;
  usedFallback: boolean; fallbackReason: FallbackReason | null;
}
export interface VersionSummary {
  id: string; number: number; status: "pending" | "approved" | "rejected" | "withdrawn" | "superseded";
  requestedAt: number; reviewedAt: number | null; reviewNote: string | null;
}
export interface UploadView { id: string; url: string; width: number; height: number; bytes: number; createdAt: number }
export interface SiteView {
  id: string; slug: string | null; rev: number;
  live: boolean; inReview: boolean; takenDown: boolean; liveUrl: string | null;
  facts: unknown; brief: unknown; edits: OwnerEdits;
  ai: { generationId: string; draft: AiDraft; usedFallback: boolean } | null;
  activeGeneration: GenerationView | null;
  pendingVersion: VersionSummary | null; liveVersion: VersionSummary | null;
  draftDiffersFromLive: boolean;
  uploads: UploadView[];
  limits: { generationsLeftToday: number; generationsLeftTotal: number };
  issues: { facts: Issue[]; brief: Issue[]; photos: Issue[]; document: Issue[] }; // document: [] when ai is null
}
export interface LeadView {
  id: string; createdAt: number; name: string; phone: string; email: string | null;
  service: string | null; message: string | null; emailStatus: "pending" | "sent" | "failed" | "skipped";
}
export interface InviteView { id: string; email: string; createdBy: string; createdAt: number; expiresAt: number; usedAt: number | null; revokedAt: number | null; siteId: string | null }
export interface AdminSiteRow extends SiteSummary { ownerId: string; ownerEmail: string; ownerDisabled: boolean; indexable: boolean; createdAt: number; updatedAt: number }
export interface ReviewChecks {
  firstPublish: boolean; testimonials: number; reviewsAttested: boolean; hiddenSections: string[];
  socialHosts: string[]; photoCount: number; usedFallbackCopy: boolean; slugFlags: string[];
  textFlags: Array<{ path: string; reason: "web_address" | "at_sign" | "other_phone" | "phishing_word" }>;
}
export interface AdminVersionDetail {
  version: VersionSummary & { siteId: string; htmlSha256: string; generationId: string | null; requestedBy: string };
  site: AdminSiteRow; document: unknown; ownerEditedPaths: string[];
  liveDocument: unknown | null; checks: ReviewChecks;
  // A16: every page the version has, in page order, from its stored pages_json ([] for a row from before A16). `url` is
  // "/api/admin/versions/<id>/pages/<page>"; `sha256` is the hash the page's stored bytes must have (the digest of all of them is version.htmlSha256).
  pages: Array<{ page: PageId; label: string; url: string; sha256: string }>;
}
export interface AdminSettings {
  generationEnabled: boolean; envGenerationEnabled: boolean; dailyModelLimit: number;
  modelCallsToday: number; spentTodayMicrousd: number;
  worstCaseDailyMicrousd: number | null; // dailyModelLimit x worst-case cost of one job for the configured model; null = no recorded price (M3)
}
