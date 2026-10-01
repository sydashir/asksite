import { DEFAULT_SECTION_ORDER, SECTION_VARIANTS, type LayoutSection, type SiteDocument, type SiteDocumentInput } from "@asksite/site-schema";
import { SECTION_IDS, type AiDraft, type CopyEdits, type OwnerEdits } from "./draft.ts";
import type { Issue } from "./issues.ts";
import { mediaUrl } from "./keys.ts";
import { canonicalJson, sha256Hex } from "./tokens.ts";

export interface CurrentAi { generationId: string; draft: AiDraft }

/** SiteDocumentInput whose facts are unvalidated (they may be incomplete while drafting). */
export type ComposedDocument = Omit<SiteDocumentInput, "facts"> & { facts: unknown };

type Intros = NonNullable<ComposedDocument["copy"]["sectionIntros"]>;
const INTRO_KEYS = ["services", "gallery", "faq", "contact"] as const;

/** Owner strings: every whitespace run (including newlines) becomes one space. Nothing else changes. */
const tidy = (text: string): string => text.replace(/\s+/g, " ");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Optional field: null = leave it out, undefined = the AI value, a string = the owner's text. */
function optional(edit: string | null | undefined, ai: string | undefined): string | undefined {
  if (edit === null) return undefined;
  return edit === undefined ? ai : tidy(edit);
}

/**
 * Every section id once (a missing one gets its first variant), in the owner's order when one applies, else in
 * the page map's order (U1, user 2026-10-01). The AI's layout picks the variants and which sections it wrote; its
 * order no longer decides anything, since each section lives on a fixed page and the owner orders within a page.
 */
function composeLayout(ai: AiDraft["layout"], order: OwnerEdits["order"]): LayoutSection[] {
  const listed = new Set(ai.map((s) => s.id));
  const missing = SECTION_IDS.filter((id) => !listed.has(id)).map((id) => ({ id, variant: SECTION_VARIANTS[id][0] }) as LayoutSection);
  const rank = new Map((order ?? DEFAULT_SECTION_ORDER).map((id, i) => [id, i]));
  return [...ai, ...missing].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

/**
 * Builds the page document. Never throws; validate the result with SiteDocument.safeParse.
 * Copy and order edits apply only while edits.baseGenerationId === ai.generationId; hidden and
 * theme always apply. Service descriptions are matched by the trimmed service name.
 */
export function composeDocument(facts: unknown, ai: CurrentAi, edits: OwnerEdits): ComposedDocument {
  const current = edits.baseGenerationId === ai.generationId;
  const e: CopyEdits = current ? edits.copy : {};
  const aiCopy = ai.draft.copy;

  const sectionIntros: Intros = {};
  for (const key of INTRO_KEYS) {
    const value = optional(e.sectionIntros?.[key], aiCopy.sectionIntros[key]);
    if (value !== undefined) sectionIntros[key] = value;
  }
  const about = optional(e.about, aiCopy.about);

  const services = isRecord(facts) && Array.isArray(facts.services) ? facts.services : [];
  const edited = e.serviceDescriptions ?? {};
  const serviceDescriptions = services.map((service: unknown) => {
    const name = isRecord(service) && typeof service.name === "string" ? service.name.trim() : "";
    const own = Object.hasOwn(edited, name) ? edited[name] : undefined;
    const description = own !== undefined ? tidy(own) : (aiCopy.serviceDescriptions.find((d) => d.service === name)?.description ?? "");
    return { service: name, description };
  });

  return {
    facts,
    copy: {
      heroHeadline: e.heroHeadline === undefined ? aiCopy.heroHeadline : tidy(e.heroHeadline),
      heroSubheadline: e.heroSubheadline === undefined ? aiCopy.heroSubheadline : tidy(e.heroSubheadline),
      ctaText: e.ctaText === undefined ? aiCopy.ctaText : tidy(e.ctaText),
      ...(about === undefined ? {} : { about }),
      sectionIntros,
      serviceDescriptions,
      faq: e.faq === undefined ? aiCopy.faq : e.faq.map((item) => ({ question: tidy(item.question), answer: tidy(item.answer) })),
    },
    layout: composeLayout(ai.draft.layout, current ? edits.order : null),
    theme: edits.theme ?? ai.draft.theme,
    hidden: [...edits.hidden], // a copy: the document never shares an array with the edits
  };
}

/** sha256Hex(canonicalJson(parsed)) for a parsed SiteDocument; used for document_sha256 and "Unpublished changes". */
export function documentSha256(parsed: SiteDocument): Promise<string> {
  return sha256Hex(canonicalJson(parsed));
}

/** Dotted paths of copy fields whose value came from the owner, e.g. "copy.heroHeadline", "copy.faq".
 *  A service description is "copy.serviceDescriptions.<service name>". */
export function ownerEditedPaths(ai: CurrentAi, edits: OwnerEdits): string[] {
  if (edits.baseGenerationId !== ai.generationId) return [];
  const copy = edits.copy;
  const paths: string[] = [];
  for (const key of ["heroHeadline", "heroSubheadline", "ctaText", "about"] as const) {
    if (copy[key] !== undefined) paths.push(`copy.${key}`);
  }
  for (const key of INTRO_KEYS) if (copy.sectionIntros?.[key] !== undefined) paths.push(`copy.sectionIntros.${key}`);
  for (const name of Object.keys(copy.serviceDescriptions ?? {})) paths.push(`copy.serviceDescriptions.${name}`);
  if (copy.faq !== undefined) paths.push("copy.faq");
  return paths;
}

/** Every facts photo (heroPhoto, photos[]) must equal mediaUrl(root, siteId, u.id) for a non-deleted upload u
 *  of this site, with width and height equal to the upload's. Returns issues at facts.heroPhoto.url etc. */
export function photoRefIssues(
  facts: unknown,
  siteId: string,
  root: string,
  uploads: ReadonlyArray<{ id: string; width: number; height: number }>,
): Issue[] {
  if (!isRecord(facts)) return [];
  const byUrl = new Map(uploads.map((u) => [mediaUrl(root, siteId, u.id), u]));
  const issues: Issue[] = [];
  const check = (photo: unknown, path: Array<string | number>) => {
    if (!isRecord(photo)) return;
    const upload = typeof photo.url === "string" ? byUrl.get(photo.url) : undefined;
    if (upload === undefined) {
      issues.push({ path: [...path, "url"], code: "photo_ref", message: "Choose a photo you uploaded for this site" });
    } else if (photo.width !== upload.width || photo.height !== upload.height) {
      issues.push({ path: [...path, "url"], code: "photo_ref", message: "This photo's size does not match the upload; choose it again" });
    }
  };
  check(facts.heroPhoto, ["facts", "heroPhoto"]);
  if (Array.isArray(facts.photos)) facts.photos.forEach((photo: unknown, i) => check(photo, ["facts", "photos", i]));
  return issues;
}
