import { HIDEABLE_SECTIONS, factSections, type HideableSectionId, type SectionId, type SiteDocument } from "@asksite/site-schema";

export const SECTION_LABEL: Record<SectionId, string> = {
  hero: "Top of the page",
  trust: "Credentials",
  services: "Services",
  testimonials: "Reviews",
  gallery: "Photos of your work",
  about: "About you",
  serviceArea: "Service area and hours",
  faq: "Questions and answers",
  contact: "Contact form",
};

export const isHideable = (id: SectionId): id is HideableSectionId => (HIDEABLE_SECTIONS as readonly string[]).includes(id);

/**
 * Whether a section has something to show. Mirrors Plan 1's renderer rule (visibility.ts
 * hasContent), which is not exported: hero always, about and FAQ when they have copy, every
 * other section when the owner's facts need it. test/client/sections.test.ts checks this against
 * real rendered pages.
 */
export function sectionHasContent(doc: SiteDocument, id: SectionId): boolean {
  if (id === "hero") return true;
  if (id === "about") return doc.copy.about !== undefined;
  if (id === "faq") return doc.copy.faq.length > 0;
  return factSections(doc.facts).includes(id);
}

/** Sections the Sections tab lists, in page order: those with content, hidden or not. */
export function listedSections(doc: SiteDocument): SectionId[] {
  return doc.layout.map((s) => s.id).filter((id) => sectionHasContent(doc, id));
}

/**
 * Swap `id` with its listed neighbour above (-1) or below (1), inside the full page order
 * (every section, §2.8 SectionOrder). Sections without content keep their places. The hero
 * never moves and nothing moves above it.
 */
export function moveSection(order: readonly SectionId[], listed: readonly SectionId[], id: SectionId, by: -1 | 1): SectionId[] {
  const at = listed.indexOf(id);
  const neighbour = listed[at + by];
  if (id === "hero" || at === -1 || neighbour === undefined || neighbour === "hero") return [...order];
  const next = [...order];
  const i = next.indexOf(id);
  const j = next.indexOf(neighbour);
  next[i] = neighbour;
  next[j] = id;
  return next;
}

export function setHidden(hidden: readonly HideableSectionId[], id: HideableSectionId, hide: boolean): HideableSectionId[] {
  const rest = hidden.filter((h) => h !== id);
  return hide ? [...rest, id] : rest;
}
