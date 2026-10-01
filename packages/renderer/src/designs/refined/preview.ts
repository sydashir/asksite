// Classic's services preview on Home (A16): the first three services, in the owner's order, as rows of the price
// list (a dotted leader to "From $N"; a service without a price shows its name only, never an invented price), and
// one link to the Services page. From 56rem the heading and the link sit beside the rows. A render.ts block, not a
// layout section: no layout entry, no hide switch, no AI text.
import { pageLink, type RenderContext } from "../../context.ts";
import { formatPrice } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { SERVICES_PREVIEW_ID } from "../../sections/ids.ts";
import { sectionHead } from "./parts.ts";
import { bandClass } from "./plan.ts";

const PREVIEW_COUNT = 3;

export function renderServicesPreview(ctx: RenderContext): SafeHtml {
  const items = ctx.doc.facts.services.slice(0, PREVIEW_COUNT);
  return html`<section id="${SERVICES_PREVIEW_ID}" class="sec ${bandClass(ctx, "preview")}" aria-labelledby="${SERVICES_PREVIEW_ID}-title">
<div class="wr pv">
${sectionHead(SERVICES_PREVIEW_ID, "Our services")}
<ul class="pv-l">
${items.map((s) => html`<li class="svc"><div class="svc-l"><h3 class="svc-n"><span>${s.name}</span></h3>${s.startingPrice !== undefined && html`<p class="pr">From ${formatPrice(s.startingPrice)}</p>`}</div></li>`)}
</ul>
<p class="pv-m"><a class="bt bt-out" href="${pageLink(ctx, "services")}">More about our services</a></p>
</div>
</section>`;
}
