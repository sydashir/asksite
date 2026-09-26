import { logLine, MAX_ISSUES } from "@asksite/app-common";
import {
  AiDraft,
  Brief,
  composeDocument,
  documentSha256,
  EMPTY_EDITS,
  mediaUrl,
  OwnerEdits,
  photoRefIssues,
  siteUrl,
  toIssues,
  type CurrentAi,
  type GenerationRow,
  type Issue,
  type SiteRow,
  type SiteVersionRow,
  type SiteView,
  type UploadRow,
  type VersionSummary,
} from "@asksite/core";
import { Facts, SiteDocument } from "@asksite/site-schema";
import { parseStored } from "./db.ts";
import type { AppDeps } from "./deps.ts";

export interface Draft {
  facts: unknown;
  brief: unknown;
  edits: OwnerEdits;
}

export type DraftIssues = SiteView["issues"];

/**
 * Stored edits passed OwnerEdits when they were saved. If a later rule refuses part of them, every
 * part that still passes is kept and the rest reads as empty, so the editor still opens (decision 36).
 */
export function storedEdits(value: unknown): OwnerEdits {
  const parsed = OwnerEdits.safeParse(value);
  if (parsed.success) return parsed.data;
  logLine({ event: "stored_json_invalid", part: "edits" });
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const part = <K extends keyof OwnerEdits>(key: K): OwnerEdits[K] => {
    const one = OwnerEdits.shape[key].safeParse(record[key]);
    return one.success ? (one.data as OwnerEdits[K]) : EMPTY_EDITS[key];
  };
  return { baseGenerationId: part("baseGenerationId"), copy: part("copy"), order: part("order"), hidden: part("hidden"), theme: part("theme") };
}

/**
 * Plan 3 stored the draft after AiDraft checked it. If a later rule refuses some of its wording, it is
 * still used when it has its three parts: the composed document then lists that wording as issues,
 * which the owner can change in the editor (decision 36).
 */
function storedAiDraft(value: unknown): AiDraft | null {
  const parsed = AiDraft.safeParse(value);
  if (parsed.success) return parsed.data;
  logLine({ event: "stored_json_invalid", part: "ai_draft" });
  const draft = (typeof value === "object" && value !== null ? value : {}) as { copy?: unknown; layout?: unknown; theme?: unknown };
  const usable = typeof draft.copy === "object" && draft.copy !== null && Array.isArray(draft.layout) && typeof draft.theme === "object" && draft.theme !== null;
  return usable ? (value as AiDraft) : null;
}

export function draftOf(site: SiteRow): Draft {
  return { facts: parseStored(site.facts_json), brief: parseStored(site.brief_json), edits: storedEdits(parseStored(site.edits_json)) };
}

/** Issues from one part of the draft, with that part's name in front of each path ("facts", "brief"). */
export const under = (root: string, issues: Issue[]): Issue[] => issues.map((issue) => ({ ...issue, path: [root, ...issue.path] }));

/** The site's AI draft: its newest succeeded generation (§2.1), or null before the first build. */
export async function currentAi(db: D1Database, siteId: string): Promise<{ ai: CurrentAi; usedFallback: boolean } | null> {
  const row = await db
    .prepare("SELECT id, output_json, used_fallback FROM generations WHERE site_id = ? AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1")
    .bind(siteId)
    .first<Pick<GenerationRow, "id" | "output_json" | "used_fallback">>();
  const draft = row === null || row.output_json === null ? null : storedAiDraft(parseStored(row.output_json));
  if (row === null || draft === null) return null;
  return { ai: { generationId: row.id, draft }, usedFallback: row.used_fallback === 1 };
}

/** Non-deleted uploads, the only photos a draft may use (§8 step 6). */
export async function liveUploads(db: D1Database, siteId: string): Promise<UploadRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM uploads WHERE site_id = ? AND deleted_at IS NULL ORDER BY created_at")
    .bind(siteId)
    .all<UploadRow>();
  return results;
}

/** The first MAX_ISSUES issues of a list (P4-3): a malformed draft could otherwise list one per element. */
const firstIssues = (issues: Issue[]): Issue[] => issues.slice(0, MAX_ISSUES);

/**
 * Everything wrong with the draft right now, at most the first MAX_ISSUES issues in each list.
 * Document issues leave out paths under "facts", because those are already listed under `facts`.
 */
export function draftIssues(draft: Draft, ai: CurrentAi | null, siteId: string, root: string, uploads: readonly UploadRow[]): DraftIssues {
  const facts = Facts.safeParse(draft.facts);
  const brief = Brief.safeParse(draft.brief);
  let document: Issue[] = [];
  if (ai !== null) {
    const parsed = SiteDocument.safeParse(composeDocument(draft.facts, ai, draft.edits));
    if (!parsed.success) document = toIssues(parsed.error).filter((issue) => issue.path[0] !== "facts");
  }
  return {
    facts: facts.success ? [] : firstIssues(under("facts", toIssues(facts.error))),
    brief: brief.success ? [] : firstIssues(under("brief", toIssues(brief.error))),
    photos: firstIssues(photoRefIssues(draft.facts, siteId, root, uploads)),
    document: firstIssues(document),
  };
}

/**
 * A version as the owner sees it. The reviewer's note reaches the owner only on a rejected version, where it
 * is the reason they are given; on every other status it is for the record only (moderator decision (a)).
 * An allowlist, so a note on any other status, today's or a later one, stays hidden (P4-12).
 */
export function toVersionSummary(row: Pick<SiteVersionRow, "id" | "number" | "status" | "requested_at" | "reviewed_at" | "review_note">): VersionSummary {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    requestedAt: row.requested_at,
    reviewedAt: row.reviewed_at,
    reviewNote: row.status === "rejected" ? row.review_note : null,
  };
}

async function versionRow(db: D1Database, id: string | null): Promise<SiteVersionRow | null> {
  return id === null ? null : db.prepare("SELECT * FROM site_versions WHERE id = ?").bind(id).first<SiteVersionRow>();
}

/** True when the draft would publish something other than the live page (§3.1 step 7). */
async function differsFromLive(draft: Draft, ai: CurrentAi | null, live: SiteVersionRow | null): Promise<boolean> {
  if (live === null) return false;
  if (ai === null) return true;
  const parsed = SiteDocument.safeParse(composeDocument(draft.facts, ai, draft.edits));
  return !parsed.success || (await documentSha256(parsed.data)) !== live.document_sha256;
}

export async function buildSiteView(env: Env, deps: AppDeps, site: SiteRow, now: number): Promise<SiteView> {
  const db = env.DB;
  const draft = draftOf(site);
  const [current, active, pending, live, uploads, limits] = await Promise.all([
    currentAi(db, site.id),
    db.prepare("SELECT * FROM generations WHERE site_id = ? AND status IN ('queued', 'running') LIMIT 1").bind(site.id).first<GenerationRow>(),
    versionRow(db, site.pending_version_id),
    versionRow(db, site.live_version_id),
    liveUploads(db, site.id),
    deps.generation.generationAllowance(env, { siteId: site.id, ownerId: site.owner_id, now }),
  ]);
  const ai = current?.ai ?? null;
  const isLive = site.live_version_id !== null && site.taken_down_at === null;
  return {
    id: site.id,
    slug: site.slug,
    rev: site.rev,
    live: isLive,
    inReview: site.pending_version_id !== null,
    takenDown: site.taken_down_at !== null,
    liveUrl: isLive && site.slug !== null ? siteUrl(env.ROOT_DOMAIN, site.slug) : null,
    facts: draft.facts,
    brief: draft.brief,
    edits: draft.edits,
    ai: current === null ? null : { generationId: current.ai.generationId, draft: current.ai.draft, usedFallback: current.usedFallback },
    activeGeneration: active === null ? null : deps.generation.toGenerationView(active),
    pendingVersion: pending === null ? null : toVersionSummary(pending),
    liveVersion: live === null ? null : toVersionSummary(live),
    draftDiffersFromLive: await differsFromLive(draft, ai, live),
    uploads: uploads.map((u) => ({ id: u.id, url: mediaUrl(env.ROOT_DOMAIN, site.id, u.id), width: u.width, height: u.height, bytes: u.bytes, createdAt: u.created_at })),
    limits,
    issues: draftIssues(draft, ai, site.id, env.ROOT_DOMAIN, uploads),
  };
}
