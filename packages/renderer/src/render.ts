import { SiteDocument, type LayoutSection, type SiteDocumentInput } from "@asksite/site-schema";
import { isVisible, type RenderContext } from "./context.ts";
import { escapeText } from "./escape.ts";
import { TRADE_LABEL } from "./format.ts";
import { fragment, html, safeUrl, SafeHtml, trusted } from "./html.ts";
import { faqPageJsonLd, jsonLdScript, localBusinessJsonLd } from "./json-ld.ts";
import { renderAbout } from "./sections/about.ts";
import { renderContact } from "./sections/contact.ts";
import { renderFaq } from "./sections/faq.ts";
import { renderCallBar, renderFooter } from "./sections/footer.ts";
import { renderGallery } from "./sections/gallery.ts";
import { renderHeader } from "./sections/header.ts";
import { renderHero } from "./sections/hero.ts";
import { renderServiceArea } from "./sections/service-area.ts";
import { renderServices } from "./sections/services.ts";
import { renderTestimonials } from "./sections/testimonials.ts";
import { renderTrust } from "./sections/trust.ts";
import { themeStyle } from "./theme.ts";
import { visibleSections } from "./visibility.ts";

export interface RenderOptions {
  /** The shared compiled stylesheet (packages/renderer/styles/site.css). Inlined into every page. */
  readonly stylesheet: string;
  /** Absolute https URL the contact form posts to. */
  readonly formAction: string;
}

// The MIT licences of the code these pages are built from ask for the copyright notice to travel
// with copies; one fixed comment per page does that (full texts: THIRD_PARTY_NOTICES.md).
const ATTRIBUTION =
  "<!-- Portions adapted from AstroWind, Copyright (c) 2023 onWidget, and Tabler Icons, Copyright (c) 2020-2026 Paweł Kuna. MIT License. -->";

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

function renderSection(ctx: RenderContext, section: LayoutSection): SafeHtml {
  switch (section.id) {
    case "hero":
      return renderHero(ctx, section.variant);
    case "trust":
      return renderTrust(ctx, section.variant);
    case "services":
      return renderServices(ctx, section.variant);
    case "testimonials":
      return renderTestimonials(ctx, section.variant);
    case "gallery":
      return renderGallery(ctx, section.variant);
    case "about":
      return renderAbout(ctx, section.variant);
    case "serviceArea":
      return renderServiceArea(ctx, section.variant);
    case "faq":
      return renderFaq(ctx, section.variant);
    case "contact":
      return renderContact(ctx, section.variant);
  }
}

/**
 * Render one complete, self-contained static HTML page. Pure: no network, no clock, no randomness.
 * The input is re-validated, so an unvalidated or tampered document throws instead of rendering.
 */
export function render(input: SiteDocumentInput, options: RenderOptions): string {
  const doc = SiteDocument.parse(input);
  const ctx: RenderContext = {
    doc,
    sections: visibleSections(doc),
    formAction: safeUrl(options.formAction, ["https:"]),
  };

  const page = html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
${trusted(ATTRIBUTION)}
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="format-detection" content="telephone=no">
<title>${pageTitle(doc)}</title>
<meta name="description" content="${doc.copy.heroSubheadline}">
${styleTag(options.stylesheet)}
${themeStyle(doc.theme)}
${jsonLdScript(localBusinessJsonLd(doc.facts))}
${isVisible(ctx, "faq") && jsonLdScript(faqPageJsonLd(doc.copy.faq))}
</head>
<body class="min-h-screen bg-page font-sans break-words text-default antialiased">
<a class="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-page focus:px-4 focus:py-2 focus:text-heading focus:shadow-lg" href="${fragment("main")}">Skip to content</a>
${renderHeader(ctx)}
<main id="main">
${ctx.sections.map((section) => renderSection(ctx, section))}
</main>
${renderFooter(ctx)}
${renderCallBar(ctx)}
</body>
</html>
`;
  return String(page);
}
