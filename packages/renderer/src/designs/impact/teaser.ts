// The Bold services preview on Home (A16): a short menu board of the first three services in the owner's order,
// each with "From $N" when the owner gave a starting price (the name alone otherwise; never an invented price),
// and the one link to the Services page. It shares the Services band's layout: the heading at the left with the
// link under it from 64rem, the board at the right.
import { pageLink, type RenderContext } from "../../context.ts";
import { formatPrice } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { SERVICES_PREVIEW_ID } from "../../sections/ids.ts";
import { icon } from "./icons.ts";
import { bandClass, sectionHead } from "./parts.ts";

const PREVIEW_COUNT = 3;

export function renderServicesTeaser(ctx: RenderContext): SafeHtml {
  const rows = ctx.doc.facts.services.slice(0, PREVIEW_COUNT).map(
    (s) =>
      html`<li class="svc"><h3 class="svc-name h3">${s.name}</h3>${s.startingPrice !== undefined && html`<p class="svc-price">From <span class="svc-amt display tnum">${formatPrice(s.startingPrice)}</span></p>`}</li>`,
  );
  return html`<section id="${SERVICES_PREVIEW_ID}" class="${bandClass(ctx, "teaser")}" aria-labelledby="${SERVICES_PREVIEW_ID}-title">
<div class="wrap svc-layout">
${sectionHead(SERVICES_PREVIEW_ID, { eyebrow: "Services", title: "Our services" })}
<ul class="board">${rows}</ul>
<p class="teaser-more"><a class="svc-ask" href="${pageLink(ctx, "services")}">More about our services${icon("arrow-right")}</a></p>
</div>
</section>`;
}
