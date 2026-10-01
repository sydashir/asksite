// The two blocks render.ts adds around a page's sections (A16), in Modern's language: Home's preview of the first
// services, and the closing band that ends every page but Contact. Neither is a layout section: no hide switch, and
// no AI text beyond the owner's call to action, which the hero shows too.
import { onSite, pageLink, type RenderContext } from "../../context.ts";
import { html, type SafeHtml } from "../../html.ts";
import { icon } from "../../icons.ts";
import { CLOSING_BAND_ID, SERVICES_PREVIEW_ID } from "../../sections/ids.ts";
import { areaItem, callButton, credentialLine, emergencyItem, freeEstimatesItem, head, priceLine, quoteButton } from "./parts.ts";

/** How many services Home previews. */
const PREVIEW_COUNT = 3;

// The preview's column count from 768 px: one per service (three is the default).
const PREVIEW_LIST = { 1: "teaser-list teaser-list--1", 2: "teaser-list teaser-list--2", 3: "teaser-list" } as const;

/**
 * Home's services preview: the first three services in the owner's order, each a ticked line with the price line of
 * the Services page ("From $N", or "Price on request" while another service has a price: no price is ever invented).
 * No row is boxed like a card, since none is a link: the one link, to the Services page, is the button level with the
 * heading. On phones each service is one ruled line, its price at the end; from 768 px the services are one row of
 * columns.
 */
export function renderServicesPreview(ctx: RenderContext, tone: string): SafeHtml {
  const items = ctx.doc.facts.services.slice(0, PREVIEW_COUNT);
  return html`<section id="${SERVICES_PREVIEW_ID}" class="sec teaser-sec ${tone}" aria-labelledby="${SERVICES_PREVIEW_ID}-title">
<div class="wrap teaser">
${head(SERVICES_PREVIEW_ID, "Our services")}
<ul class="${PREVIEW_LIST[items.length as keyof typeof PREVIEW_LIST]}">
${items.map((s) => html`<li>${icon("check", "i")}<h3 class="h3">${s.name}</h3>${priceLine(ctx.doc.facts, s.startingPrice)}</li>`)}
</ul>
<a class="button button-line teaser-more" href="${pageLink(ctx, "services")}">More about our services${icon("chevron-right", "i")}</a>
</div>
</section>`;
}

/**
 * The closing band: a card, the page's last call to action. "Get in touch" with a reason to act from the owner's own
 * facts (24/7 service, as the hero says it; free estimates, one of the credentials, so only while the site shows
 * them; with neither, the towns the business serves while the site shows them), beside (from 1024 px) the Call
 * button, which shows the number, and the owner's call to action, which leads to the quote form. The card is on the
 * brand colour, or white with the brand rule when `afterBrand` (the block before it is on the brand colour), so two
 * brand blocks never meet above the footer (judges, A16 round 1).
 */
export function renderClosingBand(ctx: RenderContext, tone: string, afterBrand: boolean): SafeHtml {
  const { facts } = ctx.doc;
  const strengths = [...(facts.emergency247 ? [emergencyItem()] : []), ...(facts.freeEstimates && onSite(ctx, "trust") ? [freeEstimatesItem()] : [])];
  const reasons = strengths.length > 0 || !onSite(ctx, "serviceArea") ? strengths : [areaItem(facts)];
  return html`<section id="${CLOSING_BAND_ID}" class="sec close ${tone}" aria-labelledby="${CLOSING_BAND_ID}-title">
<div class="wrap">
<div class="${afterBrand ? "close-card close-card--light" : "close-card on-brand"}">
${head(CLOSING_BAND_ID, "Get in touch", undefined, 2, credentialLine(reasons))}
<div class="close-cta">${callButton(facts, "button-lg")}${quoteButton(ctx, "button-lg")}</div>
</div>
</div>
</section>`;
}
