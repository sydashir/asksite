// The two blocks render.ts adds around a page's sections (A16), in Modern's language: Home's preview of the first
// services, and the closing band that ends every page but Contact. Neither is a layout section: no hide switch, no
// AI text beyond the owner's call to action, which the hero shows too.
import { pageLink, type RenderContext } from "../../context.ts";
import { formatPrice } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { CLOSING_BAND_ID, SERVICES_PREVIEW_ID } from "../../sections/ids.ts";
import { callButton, head, quoteButton } from "./parts.ts";

/** How many services Home previews. */
const PREVIEW_COUNT = 3;

/** Home's services preview: the first three services in the owner's order, each with its "From $N" when it has one, and one link to the Services page. */
export function renderServicesPreview(ctx: RenderContext, tone: string): SafeHtml {
  const items = ctx.doc.facts.services.slice(0, PREVIEW_COUNT);
  return html`<section id="${SERVICES_PREVIEW_ID}" class="sec ${tone}" aria-labelledby="${SERVICES_PREVIEW_ID}-title">
<div class="wrap">
${head(SERVICES_PREVIEW_ID, "Our services")}
<ul class="cards cards--c3">
${items.map((s) => html`<li class="card"><h3 class="h3">${s.name}</h3>${s.startingPrice !== undefined && html`<p class="price"><small>From</small> ${formatPrice(s.startingPrice)}</p>`}</li>`)}
</ul>
<div class="faq-more"><a class="button button-line" href="${pageLink(ctx, "services")}">More about our services</a></div>
</div>
</section>`;
}

/** The closing band: "Get in touch", the Call button showing the number and the owner's call to action, which leads to the quote form. */
export function renderClosingBand(ctx: RenderContext, tone: string): SafeHtml {
  return html`<section id="${CLOSING_BAND_ID}" class="sec ${tone}" aria-labelledby="${CLOSING_BAND_ID}-title">
<div class="wrap">
${head(CLOSING_BAND_ID, "Get in touch")}
<div class="about-foot">${callButton(ctx.doc.facts, "")}${quoteButton(ctx, "")}</div>
</div>
</section>`;
}
