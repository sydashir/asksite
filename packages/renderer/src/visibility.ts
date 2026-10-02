import { factSections, PAGE_IDS, PAGES, SECTION_PAGE, type LayoutSection, type PageId, type PagePath, type SectionId, type SiteDocument } from "@asksite/site-schema";

/** A section with no owner facts or copy to show is left out instead of rendering empty. */
export function hasContent(doc: SiteDocument, id: SectionId): boolean {
  switch (id) {
    case "hero":
      return true;
    case "about":
      return doc.copy.about !== undefined;
    case "faq":
      return doc.copy.faq.length > 0;
    default:
      return factSections(doc.facts).includes(id);
  }
}

/** Layout sections that render: they have content and the owner did not hide them (amendment A6). */
export function visibleSections(doc: SiteDocument): LayoutSection[] {
  const hidden: ReadonlySet<SectionId> = new Set(doc.hidden);
  return doc.layout.filter((section) => hasContent(doc, section.id) && !hidden.has(section.id));
}

/** One page of the site: its path and menu label from the page map, and the sections it draws, in order. */
export interface SitePage {
  readonly id: PageId;
  readonly path: PagePath;
  readonly label: string;
  readonly sections: readonly LayoutSection[];
}

/**
 * The pages the site renders (A16), in the page map's order, Home first: a page exists if and only if at least one
 * of its sections is visible. Within a page the sections follow doc.layout (U1, user 2026-10-01: owners reorder
 * sections within a page, and a section never leaves its page). composeDocument puts the owner's order, or the
 * page map's default, in the layout; the renderer only follows it.
 */
export function sitePages(doc: SiteDocument): readonly SitePage[] {
  const visible = visibleSections(doc);
  return PAGE_IDS.flatMap((id) => {
    const sections = visible.filter((section) => SECTION_PAGE[section.id] === id);
    return sections.length === 0 ? [] : [{ id, path: PAGES[id].path, label: PAGES[id].label, sections }];
  });
}
