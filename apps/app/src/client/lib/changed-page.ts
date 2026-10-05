import { sectionLink, sitePages, type RenderContext } from "@asksite/renderer";
import { PAGE_IDS, type PageId, type SiteDocument } from "@asksite/site-schema";

/** One rendered page: the shape both preview renders (renderPages) give. */
export interface PageHtml {
  readonly page: PageId;
  readonly html: string;
}

/**
 * What one section drew: from its opening tag (every section starts `<section id="...">`) to the next section's opening tag, or the end of
 * <main>. So the shared header, footer and call bar, and the section after it, are never part of it. null when the page has no such section.
 */
function sectionChunk(html: string, id: string): string | null {
  const start = html.indexOf(`<section id="${id}"`);
  if (start === -1) return null;
  const next = html.indexOf('<section id="', start + 1);
  const end = html.indexOf("</main>", start);
  const stop = [next, end].filter((at) => at !== -1);
  return html.slice(start, stop.length === 0 ? undefined : Math.min(...stop));
}

/**
 * The page the owner's change shows on: the first page (Home first) whose own sections drew differently, or that did not exist before.
 * It is read from what the renderer drew for the old and the new draft, so it is never a second map of which fact appears where:
 * a phone number answers "Home" (the top section shows it), opening hours "Contact", a license "Home" (Credentials), and an email address
 * (only in the shared footer) answers null, which means: keep the page on screen. Only the document's own layout sections are compared:
 * the Home services preview and the closing band are render blocks that repeat other sections' facts, so they never decide a page.
 */
export function changedPage(before: readonly PageHtml[], after: readonly PageHtml[], doc: SiteDocument): PageId | null {
  const pages = sitePages(doc);
  for (const id of PAGE_IDS) {
    const now = after.find((p) => p.page === id);
    const page = pages.find((p) => p.id === id);
    if (now === undefined || page === undefined) continue;
    const old = before.find((p) => p.page === id);
    if (old === undefined) return id;
    if (old.html === now.html) continue;
    // The renderer's own link to each section carries its element id ("#about"); a section link needs only the pages and the page.
    const ctx = { doc, page, pages } as unknown as RenderContext;
    const ids = page.sections.map((s) => String(sectionLink(ctx, s.id)).replace(/^.*#/, ""));
    if (ids.some((sectionId) => sectionChunk(old.html, sectionId) !== sectionChunk(now.html, sectionId))) return id;
  }
  return null;
}
