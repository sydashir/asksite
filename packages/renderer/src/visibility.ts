import { factSections, type LayoutSection, type SectionId, type SiteDocument } from "@asksite/site-schema";

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
