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

export function visibleSections(doc: SiteDocument): LayoutSection[] {
  return doc.layout.filter((section) => hasContent(doc, section.id));
}
