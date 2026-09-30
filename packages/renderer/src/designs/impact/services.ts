// The Bold services: a menu board. Every row shares the same grid, so the dividers line up, and the price
// cell has one style: "From $89", or a link to the form ("Free estimate" only when the owner gives them).
// From 64rem a card beside the board offers the call and the call to action.
import type { RenderContext } from "../../context.ts";
import { formatPrice } from "../../format.ts";
import { fragment, html, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { icon } from "./icons.ts";
import { bandClass, boldPage, callButton, ctaButton, sectionHead } from "./parts.ts";

export function renderServices(ctx: RenderContext): SafeHtml {
  const { facts, copy } = ctx.doc;
  const { contact } = boldPage(ctx);
  // SiteDocument guarantees serviceDescriptions[i] names facts.services[i].
  const rows = facts.services.map((service, i) => {
    const description = copy.serviceDescriptions[i]?.description;
    const price =
      service.startingPrice !== undefined
        ? html`<p class="svc-price">From <span class="svc-amt display tnum">${formatPrice(service.startingPrice)}</span></p>`
        : contact && html`<p class="svc-price"><a class="svc-ask" href="${fragment("quote")}">${facts.freeEstimates ? "Free estimate" : "Ask for a price"}${icon("arrow-right")}</a></p>`;
    return html`<li class="svc"><h3 class="svc-name h3">${service.name}</h3>${price}${description && html`<p class="svc-desc">${description}</p>`}</li>`;
  });
  // Fixed house copy: it fits every trade (cleaning and lawn care have no "problem" to describe).
  const card = html`<div class="cta-card ink">
<h3 class="h3">Not sure what you need?</h3>
<p>Call now, or tell us what you need in a quick request.</p>
<div class="cta-actions">${callButton(ctx, "action")}${contact && ctaButton(ctx)}</div>
</div>`;

  return html`<section id="${DOM_ID.services}" class="${bandClass(ctx, "services")}" aria-labelledby="${DOM_ID.services}-title">
<div class="wrap svc-layout">
${sectionHead("services", "Services", "What we do", copy.sectionIntros.services)}
<ul class="board">${rows}</ul>
${card}
</div>
</section>`;
}
