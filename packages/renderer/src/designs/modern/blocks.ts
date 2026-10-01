// The two blocks render.ts adds around a page's sections (A16), in Modern's language: Home's preview of the first
// services, and the closing band that ends every page but Contact. Neither is a layout section: no hide switch, and
// no AI text beyond the owner's call to action, which the hero shows too.
import { pageLink, type RenderContext } from "../../context.ts";
import { html, type SafeHtml } from "../../html.ts";
import { icon } from "../../icons.ts";
import { CLOSING_BAND_ID, SERVICES_PREVIEW_ID } from "../../sections/ids.ts";
import { callButton, head, price, quoteButton } from "./parts.ts";

/** How many services Home previews. */
const PREVIEW_COUNT = 3;

/**
 * Home's services preview: the first three services in the owner's order, one row each with the "From $N" pill of
 * the Services page at its end (a service without a price shows its name only: no price is ever invented), then one
 * link to the Services page. From 1024 px the rows sit beside the heading and the link, so one to three services
 * fill the band alike.
 */
export function renderServicesPreview(ctx: RenderContext, tone: string): SafeHtml {
  const items = ctx.doc.facts.services.slice(0, PREVIEW_COUNT);
  return html`<section id="${SERVICES_PREVIEW_ID}" class="sec ${tone}" aria-labelledby="${SERVICES_PREVIEW_ID}-title">
<div class="wrap teaser">
${head(SERVICES_PREVIEW_ID, "Our services")}
<ul class="preview">
${items.map((s) => html`<li class="card"><h3 class="h3">${s.name}</h3>${price(s.startingPrice)}</li>`)}
</ul>
<a class="button button-line more" href="${pageLink(ctx, "services")}">More about our services${icon("chevron-right", "i")}</a>
</div>
</section>`;
}

/**
 * The closing band: "Get in touch" beside (from 1024 px) the Call button, which shows the number, and the owner's
 * call to action, which leads to the quote form. A short band, so a visitor at the end of any page can act at once.
 */
export function renderClosingBand(ctx: RenderContext, tone: string): SafeHtml {
  return html`<section id="${CLOSING_BAND_ID}" class="sec close ${tone}" aria-labelledby="${CLOSING_BAND_ID}-title">
<div class="wrap close-in">
${head(CLOSING_BAND_ID, "Get in touch")}
<div class="close-cta">${callButton(ctx.doc.facts, "button-lg")}${quoteButton(ctx, "button-lg")}</div>
</div>
</section>`;
}
