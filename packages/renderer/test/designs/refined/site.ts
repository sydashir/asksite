// Classic's test helpers: a document drawn in Classic, one page of it or the whole site (A16).
import type { PageId, SiteDocumentInput } from "@asksite/site-schema";
import { DESIGN_CSS, FIXTURE_FORM_ACTION, FIXTURE_SITE_URL, inDesign } from "../../../../../fixtures/index.ts";
import { render, type DesignStylesheets, type RenderedSite } from "../../../src/render.ts";

/** Render options with the given sheets (the real compiled ones unless others are given). */
export const options = (stylesheets: DesignStylesheets = DESIGN_CSS) => ({ stylesheets, formAction: FIXTURE_FORM_ACTION, siteUrl: FIXTURE_SITE_URL });

/** The document's site in Classic. */
export const classicSite = (input: SiteDocumentInput, stylesheets?: DesignStylesheets): RenderedSite => render(inDesign(input, "refined"), options(stylesheets));

/** One page of the document's site in Classic; throws when the site has no such page. */
export function classicPage(input: SiteDocumentInput, page: PageId = "home", stylesheets?: DesignStylesheets): string {
  const found = classicSite(input, stylesheets).pages.find((p) => p.page === page);
  if (found === undefined) throw new Error(`The site has no ${page} page`);
  return found.html;
}

/** Every page of the document's site in Classic, one after another (for text that must hold site-wide). */
export const classicPages = (input: SiteDocumentInput, stylesheets?: DesignStylesheets): string =>
  classicSite(input, stylesheets)
    .pages.map((p) => p.html)
    .join("\n");
