import { PAGES, SiteDocument, type DesignId, type PageId, type PagePath, type SiteDocumentInput } from "@asksite/site-schema";
import { onPage, type RenderContext } from "./context.ts";
import type { Design } from "./design.ts";
import { DESIGNS } from "./designs/index.ts";
import { escapeText } from "./escape.ts";
import { formatPhone, TRADE_LABEL } from "./format.ts";
import { fragment, html, safeUrl, SafeHtml, trusted } from "./html.ts";
import { faqPageJsonLd, jsonLdScript, localBusinessJsonLd } from "./json-ld.ts";
import { themeStyle } from "./theme.ts";
import { sitePages } from "./visibility.ts";

/** A compiled stylesheet and the SHA-256 of its UTF-8 bytes. */
export interface Stylesheet {
  readonly css: string;
  readonly sha256: string;
}

/** One stylesheet per page design. @asksite/site-css's DESIGN_CSS is the real one (A12). */
export type DesignStylesheets = Readonly<Record<DesignId, Stylesheet>>;

export interface RenderOptions {
  /** Every design's compiled stylesheet. render() inlines the page's own design's, so a caller can never pair a page with another design's sheet. */
  readonly stylesheets: DesignStylesheets;
  /** Absolute https URL the contact form posts to. */
  readonly formAction: string;
  /** The site's origin, absolute https and ending in "/" (https://joes.asksite.example/): nothing but the origin. */
  readonly siteUrl: string;
}

export interface RenderedSitePage {
  readonly page: PageId;
  readonly path: PagePath;
  readonly html: string;
}

export interface RenderedSite {
  /** The site's design: the parsed document's theme.design. */
  readonly design: DesignId;
  /** The SHA-256 of the stylesheet the pages inline (stored on each version for audit). */
  readonly stylesheetSha256: string;
  /** Home first. */
  readonly pages: readonly RenderedSitePage[];
}

// Search results truncate long titles. Measured on the escaped text ("&" counts as "&amp;"),
// which is how html-validate's long-title rule counts, so this is never more lenient.
const MAX_TITLE_LENGTH = 70;
// Search results show about 160 characters of a description; counted on the raw text.
const MAX_DESCRIPTION_LENGTH = 160;

const fitsTitle = (title: string) => escapeText(title).length <= MAX_TITLE_LENGTH;

const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * `raw` itself when `fits` accepts it; otherwise its longest prefix, cut at a word boundary (else at a grapheme
 * boundary, so no emoji or accent is split), with "…" appended, that `fits` accepts. Clips the RAW text: escaping is
 * left to the html template, so an escape sequence is never cut in half.
 */
export function clipText(raw: string, fits: (text: string) => boolean): string {
  if (fits(raw)) return raw;
  const cuts = [...GRAPHEMES.segment(raw)].map((part) => part.index);
  const longest = cuts.findLast((cut) => fits(`${raw.slice(0, cut)}…`));
  if (longest === undefined) return "…";
  const wordEnd = cuts.findLast((cut) => cut > 0 && cut <= longest && /\s/.test(raw.charAt(cut)) && raw.slice(0, cut).trim() !== "");
  return `${raw.slice(0, wordEnd ?? longest).trimEnd()}…`;
}

/** The page's <title>. Home: "Name | Plumbing in Austin, TX", or just the name when that would be too long (clipped if even that is). Another page: "Services | Name", the name clipped to fit, so the label keeps every title unique. */
export function pageTitle(doc: SiteDocument, page: PageId = "home"): string {
  const { businessName, trade, location } = doc.facts;
  if (page === "home") {
    const full = `${businessName} | ${TRADE_LABEL[trade]} in ${location.city}, ${location.state}`;
    return escapeText(full).length <= MAX_TITLE_LENGTH ? full : clipText(businessName, fitsTitle);
  }
  const prefix = `${PAGES[page].label} | `;
  return prefix + clipText(businessName, (name) => fitsTitle(prefix + name));
}

/**
 * The page's meta description, from facts, fixed house words and (About) the one claim-checked copy field; no section
 * intro is used (they are optional, so three pages of a small site would share one). Home keeps the hero's subheadline.
 */
export function pageDescription(doc: SiteDocument, page: PageId): string {
  const { facts, copy } = doc;
  const { businessName: name, location } = facts;
  const trade = TRADE_LABEL[facts.trade];
  const place = `${location.city}, ${location.state}`;
  const fits = (text: string) => text.length <= MAX_DESCRIPTION_LENGTH;
  switch (page) {
    case "home":
      return copy.heroSubheadline;
    case "services":
      return clipText(`${trade} services from ${name} in ${place}. Call ${formatPhone(facts.phone)}.`, fits);
    case "about":
      if (copy.about === undefined) throw new Error("The About page has no about text");
      return clipText(copy.about, fits);
    case "gallery":
      return clipText(`Photos of recent work by ${name}, ${trade} in ${place}.`, fits);
    case "contact":
      return clipText(`Contact ${name} in ${place} for a quote, or call ${formatPhone(facts.phone)}.`, fits);
  }
}

/** Throws unless `siteUrl` is an https origin with its final "/" and nothing else (no path, query, hash or userinfo). */
function checkSiteUrl(siteUrl: string): void {
  const url = URL.canParse(siteUrl) ? new URL(siteUrl) : null;
  if (url === null || url.protocol !== "https:" || siteUrl !== `${url.origin}/`) throw new Error("siteUrl must be an https origin ending in /");
}

function styleTag(css: string): SafeHtml {
  if (/<\/style/i.test(css)) throw new Error("Stylesheet must not contain </style");
  return new SafeHtml(`<style>${css}</style>`);
}

/**
 * Render the site in the document's own design, with that design's stylesheet: one complete, self-contained static
 * HTML page per page of the site (A16), Home first. Pure: no network, no clock, no randomness. The input is
 * re-validated (a stored theme without a design gets the default), so an unvalidated or tampered document throws
 * instead of rendering.
 */
export function render(input: SiteDocumentInput, options: RenderOptions): RenderedSite {
  const doc = SiteDocument.parse(input);
  return renderDocument(doc, DESIGNS[doc.theme.design], options);
}

/** The blocks inside <main>: the page's sections in order, Home's services preview right before testimonials (after its last section when there are none), the closing band on every page but Contact. */
function mainBlocks(design: Design, ctx: RenderContext): SafeHtml[] {
  const isHome = ctx.page.id === "home";
  const blocks = ctx.page.sections.flatMap((section) => [...(isHome && section.id === "testimonials" ? [design.servicesTeaser(ctx)] : []), design.section(ctx, section)]);
  if (isHome && !onPage(ctx, "testimonials")) blocks.push(design.servicesTeaser(ctx));
  if (ctx.page.id !== "contact") blocks.push(design.closingBand(ctx));
  return blocks;
}

/**
 * The site of a parsed document, drawn by `design`, with the stylesheet of the document's own design.
 * render() is its only caller outside tests; the tests also use it to draw today's site (BASELINE) for
 * the same document, which every design is compared with. Not exported from the package.
 */
export function renderDocument(doc: SiteDocument, design: Design, options: RenderOptions): RenderedSite {
  const id = doc.theme.design;
  const stylesheet = options.stylesheets[id];
  if (stylesheet === undefined) throw new Error(`No stylesheet for the "${id}" design`);
  const formAction = safeUrl(options.formAction, ["https:"]);
  checkSiteUrl(options.siteUrl);
  const style = html`${styleTag(stylesheet.css)}
${themeStyle(doc.theme, design.variables(doc.theme))}`;
  const pages = sitePages(doc);

  const rendered = pages.map((sitePage): RenderedSitePage => {
    const ctx: RenderContext = { doc, page: sitePage, pages, formAction };
    const canonical = safeUrl(options.siteUrl + sitePage.path.slice(1), ["https:"]);
    const page = html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
${trusted(design.attribution)}
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="format-detection" content="telephone=no">
<title>${pageTitle(doc, sitePage.id)}</title>
<meta name="description" content="${pageDescription(doc, sitePage.id)}">
<link rel="canonical" href="${canonical}">
${style}
${sitePage.id === "home" && jsonLdScript(localBusinessJsonLd(doc.facts, options.siteUrl))}
${sitePage.id === "services" && onPage(ctx, "faq") && jsonLdScript(faqPageJsonLd(doc.copy.faq))}
</head>
<body data-design="${id}" class="${design.bodyClass}">
<a class="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-page focus:px-4 focus:py-2 focus:text-heading focus:shadow-lg" href="${fragment("main")}">Skip to content</a>
${design.header(ctx)}
<main id="main">
${mainBlocks(design, ctx)}
</main>
${design.footer(ctx)}
${design.callBar(ctx)}
</body>
</html>
`;
    return { page: sitePage.id, path: sitePage.path, html: String(page) };
  });
  return { design: id, stylesheetSha256: stylesheet.sha256, pages: rendered };
}
