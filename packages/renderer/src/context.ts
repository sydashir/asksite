import { PAGES, QUOTE_ID, SECTION_PAGE, type PageId, type SectionId, type SiteDocument } from "@asksite/site-schema";
import { fragment, pagePath, type SafeUrl } from "./html.ts";
import { DOM_ID } from "./sections/ids.ts";
import type { SitePage } from "./visibility.ts";

/** Everything a section needs. Built once per page by render.ts. */
export interface RenderContext {
  readonly doc: SiteDocument;
  /** The page being drawn, with the sections it holds (visible ones only, in page order). */
  readonly page: SitePage;
  /** Every page the site renders, Home first. */
  readonly pages: readonly SitePage[];
  readonly formAction: SafeUrl;
}

/** True when the section is drawn on this page. */
export function onPage(ctx: RenderContext, id: SectionId): boolean {
  return ctx.page.sections.some((s) => s.id === id);
}

/** True when the section is drawn on any page of the site. */
export function onSite(ctx: RenderContext, id: SectionId): boolean {
  return ctx.pages.some((p) => p.sections.some((s) => s.id === id));
}

/** The link to a page of the site; throws when the site has no such page, so a dead link is never written. */
export function pageLink(ctx: RenderContext, page: PageId): SafeUrl {
  if (!ctx.pages.some((p) => p.id === page)) throw new Error(`The ${page} page is not rendered`);
  return pagePath(page);
}

/** The link to a section: "#id" on this page, "/path#id" from another page; throws when the site does not draw it. */
export function sectionLink(ctx: RenderContext, id: SectionId): SafeUrl {
  if (onPage(ctx, id)) return fragment(DOM_ID[id]);
  if (!onSite(ctx, id)) throw new Error(`The ${id} section is not rendered`);
  return pagePath(SECTION_PAGE[id], DOM_ID[id]);
}

/** Every "Get a quote" link goes to the form on the Contact page (always rendered): "/contact#quote". */
export function quoteLink(): SafeUrl {
  return pagePath("contact", QUOTE_ID);
}

/** The Main navigation: every rendered page in order, and which one is this page. */
export function navItems(ctx: RenderContext): readonly { readonly href: SafeUrl; readonly label: string; readonly current: boolean }[] {
  return ctx.pages.map((p) => ({ href: pagePath(p.id), label: PAGES[p.id].label, current: p.id === ctx.page.id }));
}

/** An inner page's first section carries the page's one <h1>; every other heading is an h2 (its items an h3). */
export function headingLevel(ctx: RenderContext, id: SectionId): 1 | 2 {
  return ctx.page.id !== "home" && id === ctx.page.sections[0]?.id ? 1 : 2;
}
