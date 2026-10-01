// Modern (modern): a clean, contemporary site for a local trade, page by page (A16). On Home the owner's photo and
// the headline share the first screen and the credentials sit under the headline (or in a brand band where the owner
// places them); every other page opens with Home's brand strip, then its own heading; every page but Contact ends
// with a white card to call or ask for a quote, and from 1200 px the header offers both on every page. The design's livery (the action colour over the brand colour) marks the header,
// the current page in the menu, the hero seam, each section heading and the footer. System fonts only (zero font
// bytes), zero JavaScript. Its stylesheet is styles/sheets/modern.css; its notices are in NOTICES.md.
import type { LayoutSection } from "@asksite/site-schema";
import type { RenderContext } from "../../context.ts";
import type { Design } from "../../design.ts";
import { html, type SafeHtml } from "../../html.ts";
import { CLOSING_BAND_ID, DOM_ID, SERVICES_PREVIEW_ID } from "../../sections/ids.ts";
import { renderClosingBand, renderServicesPreview } from "./blocks.ts";
import { renderContact, renderFaq, renderServiceArea } from "./contact.ts";
import { renderCallBar, renderFooter, renderHeader } from "./frame.ts";
import { renderHero, renderTrustBand, trustInHero } from "./hero.ts";
import { renderAbout, renderGallery, renderReviews, renderServices } from "./sections.ts";
import { modernVariables } from "./tokens.ts";

// The page's one comment (A12 §7). Modern reuses the shared contact form markup (adapted from AstroWind) and
// the shared Tabler icons; both MIT licences ask for their notice to travel with copies (NOTICES.md).
const ATTRIBUTION =
  "<!-- Modern design. Portions adapted from AstroWind, Copyright (c) 2023 onWidget, and Tabler Icons, Copyright (c) 2020-2026 Paweł Kuna. MIT License. -->";

/**
 * The element ids of the page's blocks in the order render.ts draws them (A16): the page's sections, Home's services
 * preview right before the reviews (after Home's last section without them), and the closing band last on every
 * page but Contact.
 */
function blockIds(ctx: RenderContext): string[] {
  const home = ctx.page.id === "home";
  const ids = ctx.page.sections.flatMap((s) => (home && s.id === "testimonials" ? [SERVICES_PREVIEW_ID, DOM_ID[s.id]] : [DOM_ID[s.id]]));
  if (home && !ids.includes(SERVICES_PREVIEW_ID)) ids.push(SERVICES_PREVIEW_ID);
  if (ctx.page.id !== "contact") ids.push(CLOSING_BAND_ID);
  return ids;
}

/** The blocks on the brand colour: About and the trust band (the hero is never one of the blocks this decides on). */
const ON_BRAND: readonly string[] = [DOM_ID.hero, DOM_ID.about, DOM_ID.trust];

/**
 * The background of a block below the hero, in the order the page shows them: About and the trust band are on the
 * brand colour, the others alternate tint and white, starting with tint.
 */
function tone(ctx: RenderContext, domId: string): string {
  return blockIds(ctx).filter((id) => !ON_BRAND.includes(id)).indexOf(domId) % 2 === 0 ? "tint" : "white";
}

function renderSection(ctx: RenderContext, section: LayoutSection): SafeHtml {
  switch (section.id) {
    case "hero":
      return renderHero(ctx, section.variant);
    case "trust":
      // Straight after the hero, the hero draws it under the headline.
      return trustInHero(ctx) ? html`` : renderTrustBand(ctx.doc.facts);
    case "services":
      return renderServices(ctx, section.variant, tone(ctx, DOM_ID.services));
    case "testimonials":
      return renderReviews(ctx, section.variant, tone(ctx, DOM_ID.testimonials));
    case "gallery":
      return renderGallery(ctx, section.variant, tone(ctx, DOM_ID.gallery));
    case "about":
      return renderAbout(ctx, section.variant);
    case "serviceArea":
      return renderServiceArea(ctx, section.variant, tone(ctx, DOM_ID.serviceArea));
    case "faq":
      return renderFaq(ctx, section.variant, tone(ctx, DOM_ID.faq));
    case "contact":
      return renderContact(ctx, section.variant, tone(ctx, DOM_ID.contact));
  }
}

export const design: Design = Object.freeze({
  attribution: ATTRIBUTION,
  bodyClass: "page",
  variables: modernVariables,
  header: renderHeader,
  section: renderSection,
  servicesTeaser: (ctx: RenderContext) => renderServicesPreview(ctx, tone(ctx, SERVICES_PREVIEW_ID)),
  closingBand: (ctx: RenderContext) => renderClosingBand(ctx, tone(ctx, CLOSING_BAND_ID)),
  footer: renderFooter,
  callBar: renderCallBar,
});
