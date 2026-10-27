import { PAGES, QUOTE_ID, SECTION_PAGE, type PageId, type SectionId, type SiteDocument } from "@asksite/site-schema";
import { fragment, pagePath, shopUrl, type SafeUrl } from "./html.ts";
import { DOM_ID } from "./sections/ids.ts";
import type { Product, ShopSettings } from "./shop/model.ts";
import type { SitePage } from "./visibility.ts";

/**
 * A site with products: what every page of it needs (shop/render-shop.ts builds it). PROVISIONAL until lane A's shop
 * contract lands in site-schema (phase 2), when the products and settings come from the document's facts.
 */
export interface ShopState {
  /** The site's products in display order, at least one. */
  readonly products: readonly Product[];
  readonly settings: ShopSettings | undefined;
  /** Where product photos live, "https://media.<root>/<siteId>/" (RenderOptions.mediaBase, checked). */
  readonly mediaBase: string;
  /** A shop business (trade "shop" in phase 2): Shop is the second menu item and Home's product block follows the hero. */
  readonly shopFirst: boolean;
}

/** The shop page being drawn: the Shop page, a product page, or the cart and order-sent shells. */
export type ShopPage = "shop" | "product" | "cart" | "sent";

/** Everything a section needs. Built once per page by render.ts. */
export interface RenderContext {
  readonly doc: SiteDocument;
  /**
   * The page being drawn, with the sections it holds (visible ones only, in page order). On a shop page (shopPage set)
   * it is a stand-in with no sections, so a design's page branches behave: "gallery" for the Shop and product pages,
   * "contact" for the cart and sent shells (a static call bar that never covers the order form's Send button).
   */
  readonly page: SitePage;
  /** Every page the site renders, Home first. */
  readonly pages: readonly SitePage[];
  readonly formAction: SafeUrl;
  /** The site's shop, present exactly when it has products: every page then links to Shop and Cart. */
  readonly shop?: ShopState;
  /** Set only on a shop page; the site's own pages leave it out. */
  readonly shopPage?: ShopPage;
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

/**
 * The Main navigation: every rendered page in order, and which one is this page. A site with products adds "Shop"
 * (right after Home for a shop business, else after Services, else after Home) and ends with "Cart"; on a shop page no
 * site page is the current one.
 */
export function navItems(ctx: RenderContext): readonly { readonly href: SafeUrl; readonly label: string; readonly current: boolean }[] {
  const items = ctx.pages.map((p) => ({ href: pagePath(p.id), label: PAGES[p.id].label, current: ctx.shopPage === undefined && p.id === ctx.page.id }));
  if (ctx.shop === undefined) return items;
  const services = ctx.pages.findIndex((p) => p.id === "services");
  const after = ctx.shop.shopFirst || services === -1 ? 0 : services;
  return [
    ...items.slice(0, after + 1),
    { href: shopUrl("shop"), label: "Shop", current: ctx.shopPage === "shop" },
    ...items.slice(after + 1),
    { href: shopUrl("cart"), label: "Cart", current: ctx.shopPage === "cart" },
  ];
}

/** An inner page's first section carries the page's one <h1>; every other heading is an h2 (its items an h3). */
export function headingLevel(ctx: RenderContext, id: SectionId): 1 | 2 {
  return ctx.page.id !== "home" && id === ctx.page.sections[0]?.id ? 1 : 2;
}
