// The Bold services preview on Home (A16): the first three services in the owner's order, each with its
// starting price when the owner gave one, and one link to the Services page.
import { pageLink, type RenderContext } from "../../context.ts";
import { formatPrice } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { SERVICES_PREVIEW_ID } from "../../sections/ids.ts";

const PREVIEW_COUNT = 3;

export function renderServicesTeaser(ctx: RenderContext): SafeHtml {
  const items = ctx.doc.facts.services.slice(0, PREVIEW_COUNT);
  return html`<section id="${SERVICES_PREVIEW_ID}" class="sec paper" aria-labelledby="${SERVICES_PREVIEW_ID}-title">
<div class="wrap">
<div class="sec-head"><h2 id="${SERVICES_PREVIEW_ID}-title" class="h2 display">Our services</h2></div>
<ul class="board">${items.map((s) => html`<li class="svc"><h3 class="svc-name h3">${s.name}</h3>${s.startingPrice !== undefined && html`<p class="svc-price">From <span class="svc-amt display tnum">${formatPrice(s.startingPrice)}</span></p>`}</li>`)}</ul>
<p><a href="${pageLink(ctx, "services")}">More about our services</a></p>
</div>
</section>`;
}
