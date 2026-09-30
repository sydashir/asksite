// Modern (modern): a clean, contemporary page for a local trade. The owner's photo and the headline share the
// first screen, the credentials sit under the headline, and the design's livery (the action colour over the brand
// colour) marks the header, the hero seam, each section heading and the footer. System fonts only (zero font
// bytes), zero JavaScript. Its stylesheet is styles/sheets/modern.css; its notices are in NOTICES.md.
import type { LayoutSection, SectionId } from "@asksite/site-schema";
import type { RenderContext } from "../../context.ts";
import type { Design } from "../../design.ts";
import { html, type SafeHtml } from "../../html.ts";
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
 * The background of each section below the hero, in the order the page shows them: About is the brand band,
 * the others alternate tint and white. A trust section the hero holds takes none.
 */
function tone(ctx: RenderContext, id: SectionId): string {
  const banded = ctx.sections.filter((s) => s.id !== "hero" && s.id !== "about" && !(s.id === "trust" && trustInHero(ctx)));
  return banded.findIndex((s) => s.id === id) % 2 === 0 ? "tint" : "white";
}

function renderSection(ctx: RenderContext, section: LayoutSection): SafeHtml {
  switch (section.id) {
    case "hero":
      return renderHero(ctx, section.variant);
    case "trust":
      // Straight after the hero, the hero draws it under the headline.
      return trustInHero(ctx) ? html`` : renderTrustBand(ctx.doc.facts, tone(ctx, "trust"));
    case "services":
      return renderServices(ctx, section.variant, tone(ctx, "services"));
    case "testimonials":
      return renderReviews(ctx, section.variant, tone(ctx, "testimonials"));
    case "gallery":
      return renderGallery(ctx, section.variant, tone(ctx, "gallery"));
    case "about":
      return renderAbout(ctx, section.variant);
    case "serviceArea":
      return renderServiceArea(ctx, section.variant, tone(ctx, "serviceArea"));
    case "faq":
      return renderFaq(ctx, section.variant, tone(ctx, "faq"));
    case "contact":
      return renderContact(ctx, section.variant, tone(ctx, "contact"));
  }
}

export const design: Design = Object.freeze({
  attribution: ATTRIBUTION,
  bodyClass: "page",
  variables: modernVariables,
  header: renderHeader,
  section: renderSection,
  footer: renderFooter,
  callBar: renderCallBar,
});
