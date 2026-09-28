import { SiteDocument, type DesignId, type SiteDocumentInput } from "@asksite/site-schema";
import { isVisible, type RenderContext } from "./context.ts";
import { DESIGNS } from "./designs/index.ts";
import { escapeText } from "./escape.ts";
import { TRADE_LABEL } from "./format.ts";
import { fragment, html, safeUrl, SafeHtml, trusted } from "./html.ts";
import { faqPageJsonLd, jsonLdScript, localBusinessJsonLd } from "./json-ld.ts";
import { themeStyle } from "./theme.ts";
import { visibleSections } from "./visibility.ts";

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
}

export interface RenderedPage {
  readonly html: string;
  /** The page's design: the parsed document's theme.design. */
  readonly design: DesignId;
  /** The SHA-256 of the stylesheet the page inlines (stored on each version for audit). */
  readonly stylesheetSha256: string;
}

// Search results truncate long titles. Measured on the escaped text ("&" counts as "&amp;"),
// which is how html-validate's long-title rule counts, so this is never more lenient.
const MAX_TITLE_LENGTH = 70;

/** "Name | Plumbing in Austin, TX", or just the name when that would be too long. */
export function pageTitle(doc: SiteDocument): string {
  const { businessName, trade, location } = doc.facts;
  const full = `${businessName} | ${TRADE_LABEL[trade]} in ${location.city}, ${location.state}`;
  return escapeText(full).length <= MAX_TITLE_LENGTH ? full : businessName;
}

function styleTag(css: string): SafeHtml {
  if (/<\/style/i.test(css)) throw new Error("Stylesheet must not contain </style");
  return new SafeHtml(`<style>${css}</style>`);
}

/**
 * Render one complete, self-contained static HTML page in the document's own design, with that design's
 * stylesheet. Pure: no network, no clock, no randomness. The input is re-validated (a stored theme
 * without a design gets the default), so an unvalidated or tampered document throws instead of rendering.
 */
export function render(input: SiteDocumentInput, options: RenderOptions): RenderedPage {
  const doc = SiteDocument.parse(input);
  const id = doc.theme.design;
  const design = DESIGNS[id];
  const stylesheet = options.stylesheets[id];
  if (stylesheet === undefined) throw new Error(`No stylesheet for the "${id}" design`);
  const ctx: RenderContext = {
    doc,
    sections: visibleSections(doc),
    formAction: safeUrl(options.formAction, ["https:"]),
  };

  const page = html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
${trusted(design.attribution)}
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="format-detection" content="telephone=no">
<title>${pageTitle(doc)}</title>
<meta name="description" content="${doc.copy.heroSubheadline}">
${styleTag(stylesheet.css)}
${themeStyle(doc.theme, design.variables(doc.theme))}
${jsonLdScript(localBusinessJsonLd(doc.facts))}
${isVisible(ctx, "faq") && jsonLdScript(faqPageJsonLd(doc.copy.faq))}
</head>
<body data-design="${id}" class="${design.bodyClass}">
<a class="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-page focus:px-4 focus:py-2 focus:text-heading focus:shadow-lg" href="${fragment("main")}">Skip to content</a>
${design.header(ctx)}
<main id="main">
${ctx.sections.map((section) => design.section(ctx, section))}
</main>
${design.footer(ctx)}
${design.callBar(ctx)}
</body>
</html>
`;
  return { html: String(page), design: id, stylesheetSha256: stylesheet.sha256 };
}
