// The Bold services preview on Home (A16 2.3 and moderator ruling (a)): the first three services in the owner's
// order, each its name and "From $N" only when the owner gave a price (a service without one shows its name only),
// on the Services page's menu board, and exactly one link, "More about our services", to that page. From 64rem the
// heading and the link sit at the left of the board.
import { pageLink, type RenderContext } from "../../context.ts";
import { formatPrice } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { SERVICES_PREVIEW_ID } from "../../sections/ids.ts";
import { icon } from "./icons.ts";
import { bandClass, buttonClass, sectionHead } from "./parts.ts";

const PREVIEW_COUNT = 3;

export function renderServicesTeaser(ctx: RenderContext): SafeHtml {
  const rows = ctx.doc.facts.services.slice(0, PREVIEW_COUNT).map(
    (service) =>
      html`<li class="svc svc--pv"><h3 class="svc-name h3">${service.name}</h3>${service.startingPrice !== undefined && html`<p class="svc-price">From <span class="svc-amt display tnum">${formatPrice(service.startingPrice)}</span></p>`}</li>`,
  );
  return html`<section id="${SERVICES_PREVIEW_ID}" class="${bandClass(ctx, "teaser")}" aria-labelledby="${SERVICES_PREVIEW_ID}-title">
<div class="wrap pv">
${sectionHead(SERVICES_PREVIEW_ID, { eyebrow: "Services", title: "Our services" })}
<ul class="board">${rows}</ul>
<p class="svc-all"><a class="${buttonClass(ctx, "ghost")}" href="${pageLink(ctx, "services")}">More about our services${icon("arrow-right")}</a></p>
</div>
</section>`;
}
