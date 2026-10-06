// Classic (refined): a warm, printed-paper look for trades that sell on trust. Serif headings from each
// platform's own fonts (zero font bytes), a price list with dotted leaders, the owner's photo as a framed
// print or, without one, a business card, and a sticky header and phone call bar that keep Call in reach.
import type { LayoutSection } from "@asksite/site-schema";
import type { RenderContext } from "../../context.ts";
import type { Design } from "../../design.ts";
import type { SafeHtml } from "../../html.ts";
import { renderAbout } from "./about.ts";
import { renderServiceArea } from "./area.ts";
import { renderClosingBand } from "./closing.ts";
import { renderContact } from "./contact.ts";
import { renderFaq } from "./faq.ts";
import { renderCallBar, renderFooter } from "./footer.ts";
import { renderGallery } from "./gallery.ts";
import { renderHeader } from "./header.ts";
import { renderHero } from "./hero.ts";
import { renderServicesPreview } from "./preview.ts";
import { renderReviews } from "./reviews.ts";
import { renderServices } from "./services.ts";
import { variables } from "./tokens.ts";
import { renderTrust } from "./trust.ts";

// The copyright notices of the code this design is built from (NOTICES.md): the contact form's fields,
// ported from AstroWind, and Tabler Icons. Both MIT, which asks for the notice to travel with copies.
const ATTRIBUTION =
  "<!-- Portions adapted from AstroWind, Copyright (c) 2023 onWidget, and Tabler Icons, Copyright (c) 2020-2026 Paweł Kuna. MIT License. -->";

function renderSection(ctx: RenderContext, section: LayoutSection): SafeHtml {
  switch (section.id) {
    case "hero":
      return renderHero(ctx);
    case "trust":
      return renderTrust(ctx);
    case "services":
      return renderServices(ctx);
    case "testimonials":
      return renderReviews(ctx);
    case "gallery":
      return renderGallery(ctx);
    case "about":
      return renderAbout(ctx);
    case "serviceArea":
      return renderServiceArea(ctx);
    case "faq":
      return renderFaq(ctx, section.variant);
    case "contact":
      return renderContact(ctx);
  }
}

export const design: Design = Object.freeze({
  attribution: ATTRIBUTION,
  bodyClass: "classic",
  variables,
  header: renderHeader,
  section: renderSection,
  servicesTeaser: renderServicesPreview,
  closingBand: renderClosingBand,
  footer: renderFooter,
  callBar: renderCallBar,
});
