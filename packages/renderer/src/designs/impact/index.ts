// Bold (design id "impact", A12): an ink-and-paper page for trades that take emergency calls, built from the
// approved mockup (bold-v2 round 4) and its judges' must-fix list. Condensed display type (Archivo Condensed
// ExtraBold, embedded in styles/sheets/impact.css) carries the headings, buttons and prices; the body stays in
// the owner's lettering choice. Licences and notices: NOTICES.md.
import type { LayoutSection } from "@asksite/site-schema";
import type { RenderContext } from "../../context.ts";
import type { Design } from "../../design.ts";
import { html, type SafeHtml } from "../../html.ts";
import { renderAbout } from "./about.ts";
import { renderServiceArea } from "./area.ts";
import { renderContact } from "./contact.ts";
import { renderCredentials } from "./credentials.ts";
import { renderFaq } from "./faq.ts";
import { renderCallBar, renderFooter } from "./footer.ts";
import { renderGallery } from "./gallery.ts";
import { renderHeader } from "./header.ts";
import { renderHero } from "./hero.ts";
import { boldPage } from "./parts.ts";
import { renderReviews } from "./reviews.ts";
import { renderServices } from "./services.ts";
import { boldVariables } from "./tokens.ts";

// The page's one comment: the copyright notices of the code, icons and font this design is built from.
const ATTRIBUTION =
  "<!-- Portions adapted from AstroWind, Copyright (c) 2023 onWidget, and Tabler Icons, Copyright (c) 2020-2026 Paweł Kuna. MIT License. Heading font: Archivo, Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo), SIL Open Font License 1.1 (https://openfontlicense.org). -->";

function renderSection(ctx: RenderContext, section: LayoutSection): SafeHtml {
  switch (section.id) {
    case "hero":
      return renderHero(ctx, section.variant);
    case "trust":
      // Straight under the hero, the credentials are the hero's own card.
      return boldPage(ctx).trustInHero ? html`` : renderCredentials(ctx);
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
      return renderContact(ctx, section.variant);
  }
}

export const design: Design = Object.freeze({
  attribution: ATTRIBUTION,
  bodyClass: "bold",
  variables: boldVariables,
  header: renderHeader,
  section: renderSection,
  footer: renderFooter,
  callBar: renderCallBar,
});
