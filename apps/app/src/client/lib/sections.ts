import type { ComposedDocument } from "@asksite/core";
import { ALWAYS_PAGES, HIDEABLE_SECTIONS, PAGE_IDS, SECTION_PAGE, factSections, type Facts, type HideableSectionId, type PageId, type SectionId } from "@asksite/site-schema";

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
export function sectionHasContent(doc: ComposedDocument, id: SectionId): boolean {
  if (id === "hero") return true;
  if (id === "about") return doc.copy.about !== undefined;
  if (id === "faq") return (doc.copy.faq?.length ?? 0) > 0;
  return factSectionsOf(doc.facts).includes(id);
}

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** factSections for facts that may be half typed (the composed draft is not validated): a missing or odd field counts as empty. */
function factSectionsOf(facts: unknown): SectionId[] {
  const f = (typeof facts === "object" && facts !== null ? facts : {}) as Record<string, unknown>;
  return factSections({ licences: asList(f["licences"]), insured: f["insured"] === true, yearFounded: f["yearFounded"], emergency247: f["emergency247"] === true, testimonials: asList(f["testimonials"]), photos: asList(f["photos"]) } as unknown as Facts);
}

/** Sections the Sections tab lists, in page order: those with content, hidden or not. Takes the composed draft, valid or not. */
export function listedSections(doc: ComposedDocument): SectionId[] {
  return doc.layout.map((s) => s.id).filter((id) => sectionHasContent(doc, id));
}

/** The listed sections of one page, in the owner's order (`order` is the full SectionOrder). */
const pageSections = (order: readonly SectionId[], listed: readonly SectionId[], page: PageId): SectionId[] =>
  order.filter((id) => SECTION_PAGE[id] === page && listed.includes(id));

/**
 * Swap `id` with its neighbour above (-1) or below (1) IN THE SAME PAGE, inside the full order (every section, §2.8
 * SectionOrder; U1: owners reorder within a page and a section never leaves its page). Sections without content keep
 * their places, and so does every other page's. The hero never moves and nothing moves above it.
 */
export function moveSection(order: readonly SectionId[], listed: readonly SectionId[], id: SectionId, by: -1 | 1): SectionId[] {
  const group = pageSections(order, listed, SECTION_PAGE[id]);
  const neighbour = group[group.indexOf(id) + by];
  if (id === "hero" || !group.includes(id) || neighbour === undefined || neighbour === "hero") return [...order];
  const next = [...order];
  next[order.indexOf(id)] = neighbour;
  next[order.indexOf(neighbour)] = id;
  return next;
}

/** Whether Move up (-1) or Move down (1) would change anything: false at the edge of the page's group. */
export const canMove = (order: readonly SectionId[], listed: readonly SectionId[], id: SectionId, by: -1 | 1): boolean =>
  moveSection(order, listed, id, by).some((section, i) => section !== order[i]);

/** The listed sections grouped by the page they live on, pages in the page map's order, a page with none left out. */
export function sectionsByPage(order: readonly SectionId[], listed: readonly SectionId[]): Array<{ page: PageId; sections: SectionId[] }> {
  return PAGE_IDS.map((page) => ({ page, sections: pageSections(order, listed, page) })).filter((group) => group.sections.length > 0);
}

/** The page that hiding `id` takes out of the site's menu (null when the page stays: it always exists, or has other visible sections). */
export function pageRemovedByHiding(listed: readonly SectionId[], hidden: readonly string[], id: SectionId): PageId | null {
  const page = SECTION_PAGE[id];
  if ((ALWAYS_PAGES as readonly PageId[]).includes(page) || !listed.includes(id)) return null;
  const others = listed.filter((other) => other !== id && SECTION_PAGE[other] === page && !hidden.includes(other));
  return others.length === 0 ? page : null;
}

/**
 * The section a wording field (a path under "copy") belongs to, so the preview can show that section's page while the
 * owner edits it (A16 UX-8). The one small field-to-section map.
 */
export function sectionOfCopy(path: ReadonlyArray<string | number>): SectionId {
  const [, field, key] = path;
  if (field === "about") return "about";
  if (field === "faq") return "faq";
  if (field === "serviceDescriptions") return "services";
  if (field === "sectionIntros") return key === "faq" ? "faq" : key === "gallery" ? "gallery" : key === "contact" ? "contact" : "services";
  return "hero";
}

export function setHidden(hidden: readonly HideableSectionId[], id: HideableSectionId, hide: boolean): HideableSectionId[] {
  const rest = hidden.filter((h) => h !== id);
  return hide ? [...rest, id] : rest;
}
