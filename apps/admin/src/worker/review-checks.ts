import { logLine, slugFlags } from "@asksite/app-common";
import { AiDraft, Brief, OwnerEdits, ownerEditedPaths, type ReviewChecks, type SiteVersionRow } from "@asksite/core";
import { SiteDocument } from "@asksite/site-schema";
import type { SiteWithOwner } from "./db.ts";
import { textFlags } from "./text-flags.ts";

// Nothing here may throw on stored data: the reviewer must always be able to open a version, and
// then reject it or take the site down (decision 36).

/** JSON column text to a value, or null when it is not JSON. */
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** A link's host, or the link as stored when it does not parse. try/catch, not URL.canParse (Safari 17+): one pattern everywhere (A9). */
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** What the reviewer sees next to the stored page (§3.2 step 3, §4.2 ReviewChecks). */
export function reviewChecks(input: { site: SiteWithOwner; document: SiteDocument; usedFallback: boolean }): ReviewChecks {
  const { site, document } = input;
  const brief = Brief.safeParse(parseJson(site.brief_json));
  return {
    firstPublish: site.live_version_id === null,
    testimonials: document.facts.testimonials.length,
    reviewsAttested: brief.success && brief.data.reviewsAreReal,
    hiddenSections: [...document.hidden],
    socialHosts: document.facts.socialLinks.map((link) => hostOf(link.url)),
    photoCount: (document.facts.heroPhoto === undefined ? 0 : 1) + document.facts.photos.length,
    usedFallbackCopy: input.usedFallback,
    slugFlags: site.slug === null ? [] : slugFlags(site.slug),
    // Every flag, never capped (moderator ruling, 2026-09-30): the facts schema bounds it at 118 strings x 4 reasons.
    textFlags: textFlags(document.facts),
  };
}

/** The wording the owner changed in this version, from the AI draft it was made from. */
export function editedPaths(version: SiteVersionRow, outputJson: string | null): string[] {
  if (version.generation_id === null || outputJson === null) return [];
  const draft = AiDraft.safeParse(parseJson(outputJson));
  const edits = OwnerEdits.safeParse(parseJson(version.edits_json));
  return draft.success && edits.success ? ownerEditedPaths({ generationId: version.generation_id, draft: draft.data }, edits.data) : [];
}

/**
 * A stored document (§2.5: parsed when it was stored, with every default filled in). If a later
 * Plan 1 rule refuses it, it is still shown as stored, so the reviewer can still act on it.
 */
export function storedDocument(json: string): SiteDocument {
  const value = parseJson(json);
  const parsed = SiteDocument.safeParse(value);
  if (parsed.success) return parsed.data;
  if (typeof value !== "object" || value === null) throw new Error("stored document is not JSON");
  logLine({ event: "stored_json_invalid", part: "document" });
  return value as SiteDocument;
}
