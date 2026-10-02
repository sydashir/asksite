// Today's page (Plan 1) as a Design (A12). Every design id renders it until that design's own build
// replaces its folder's index.ts. It sits outside src/designs, so styles/sheets/baseline.css reads it
// and no design folder.
import type { LayoutSection } from "@asksite/site-schema";
import type { RenderContext } from "./context.ts";
import type { Design } from "./design.ts";
import type { SafeHtml } from "./html.ts";
import { renderAbout } from "./sections/about.ts";
import { renderContact } from "./sections/contact.ts";
import { renderFaq } from "./sections/faq.ts";
import { renderClosingBand } from "./sections/closing-band.ts";
import { renderCallBar, renderFooter } from "./sections/footer.ts";
import { renderGallery } from "./sections/gallery.ts";
import { renderHeader } from "./sections/header.ts";
import { renderHero } from "./sections/hero.ts";
import { renderServiceArea } from "./sections/service-area.ts";
import { renderServices } from "./sections/services.ts";
import { renderServicesPreview } from "./sections/services-preview.ts";
import { renderTestimonials } from "./sections/testimonials.ts";
import { renderTrust } from "./sections/trust.ts";

// The MIT licences of the code these pages are built from ask for the copyright notice to travel
// with copies; one fixed comment per page does that (full texts: THIRD_PARTY_NOTICES.md).
const ATTRIBUTION =
  "<!-- Portions adapted from AstroWind, Copyright (c) 2023 onWidget, and Tabler Icons, Copyright (c) 2020-2026 Paweł Kuna. MIT License. -->";

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

export const BASELINE: Design = Object.freeze({
  attribution: ATTRIBUTION,
  bodyClass: "min-h-screen bg-page font-sans break-words text-default antialiased",
  variables: () => ({}),
  header: renderHeader,
  section: renderSection,
  servicesTeaser: renderServicesPreview,
  closingBand: renderClosingBand,
  footer: renderFooter,
  callBar: renderCallBar,
});
