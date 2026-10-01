// The Bold services preview on Home (A16): the Services page's board for the first three services in the owner's
// order, each with its price ("From $N" only when the owner gave one, never an invented price) or the same free
// estimate cue, and its description. Each row leads to the Services page, and so does the button under the board,
// which names the count when there are more ("See all 12 services"). From 64rem the "Not sure what you need?" card
// fills the column under the heading (phones have the call bar).
import { pageLink, type RenderContext } from "../../context.ts";
import { html, type SafeHtml } from "../../html.ts";
import { SERVICES_PREVIEW_ID } from "../../sections/ids.ts";
import { icon } from "./icons.ts";
import { bandClass, buttonClass, sectionHead } from "./parts.ts";
import { ctaCard, serviceRow } from "./services.ts";

const PREVIEW_COUNT = 3;

export function renderServicesTeaser(ctx: RenderContext): SafeHtml {
  const { facts, copy } = ctx.doc;
  const services = pageLink(ctx, "services");
  const rows = facts.services.slice(0, PREVIEW_COUNT).map((service, i) => serviceRow(ctx, service, copy.serviceDescriptions[i]?.description, 2, services));
  const count = facts.services.length;
  return html`<section id="${SERVICES_PREVIEW_ID}" class="${bandClass(ctx, "teaser")}" aria-labelledby="${SERVICES_PREVIEW_ID}-title">
<div class="wrap svc-layout">
${sectionHead(SERVICES_PREVIEW_ID, { eyebrow: "Services", title: "Our services", intro: copy.sectionIntros.services })}
<div class="svc-main"><ul class="board">${rows}</ul>
<p class="svc-all"><a class="${buttonClass(ctx, "ghost")}" href="${services}">${count > PREVIEW_COUNT ? `See all ${count} services` : "More about our services"}${icon("arrow-right")}</a></p></div>
${ctaCard(ctx, 2, "cta-card cta-card--home ink")}
</div>
</section>`;
}
