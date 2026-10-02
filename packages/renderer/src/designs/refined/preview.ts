// Classic's services preview on Home (A16): the owner's own services intro under the heading, then the first three
// services in the owner's order as rows of the price list, each with a dotted leader to "From $N", or to "Price on
// request" as on the Services page (never an invented price), and one link to the Services page that says how many
// services it lists. From 56rem the heading sits beside the rows, the link under them. A render.ts block, not a
// layout section: no layout entry, no hide switch, no new AI text.
import { pageLink, type RenderContext } from "../../context.ts";
import { formatPrice } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { SERVICES_PREVIEW_ID } from "../../sections/ids.ts";
import { sectionHead } from "./parts.ts";
import { bandClass } from "./plan.ts";

const PREVIEW_COUNT = 3;

export function renderServicesPreview(ctx: RenderContext): SafeHtml {
  const { services } = ctx.doc.facts;
  const items = services.slice(0, PREVIEW_COUNT);
  const more = services.length > PREVIEW_COUNT ? `See all ${services.length} services` : "More about our services";
  return html`<section id="${SERVICES_PREVIEW_ID}" class="sec ${bandClass(ctx, "preview")}" aria-labelledby="${SERVICES_PREVIEW_ID}-title">
<div class="wr pv">
${sectionHead(SERVICES_PREVIEW_ID, "Our services", ctx.doc.copy.sectionIntros.services)}
<ul class="pv-l">
${items.map((s) => html`<li class="svc"><div class="svc-l"><h3 class="svc-n"><span>${s.name}</span></h3>${s.startingPrice === undefined ? html`<p class="pr pr-ask">Price on request</p>` : html`<p class="pr">From ${formatPrice(s.startingPrice)}</p>`}</div></li>`)}
</ul>
<p class="pv-m"><a class="bt bt-out" href="${pageLink(ctx, "services")}">${more}</a></p>
</div>
</section>`;
}
