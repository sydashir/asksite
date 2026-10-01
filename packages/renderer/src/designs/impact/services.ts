// The Bold services: a menu board. Every row shares the same grid, so the dividers line up, and the price
// cell has one style: "From $89", or a link to the form ("Free estimate" only when the owner gives them).
// From 64rem a card beside the board offers the call and the call to action. When the section opens the Services
// page its heading is the page's <h1>, so the service names are h2s (A16: no heading level skipped).
import { headingLevel, quoteLink, type RenderContext } from "../../context.ts";
import { formatPrice } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { itemHeading } from "../../ui.ts";
import { icon } from "./icons.ts";
import { band, boldPage, callButton, ctaButton } from "./parts.ts";

export function renderServices(ctx: RenderContext): SafeHtml {
  const { facts, copy } = ctx.doc;
  const { contact } = boldPage(ctx);
  const level = headingLevel(ctx, "services");
  // SiteDocument guarantees serviceDescriptions[i] names facts.services[i].
  const rows = facts.services.map((service, i) => {
    const description = copy.serviceDescriptions[i]?.description;
    const price =
      service.startingPrice !== undefined
        ? html`<p class="svc-price">From <span class="svc-amt display tnum">${formatPrice(service.startingPrice)}</span></p>`
        : contact && html`<p class="svc-price"><a class="svc-ask" href="${quoteLink()}">${facts.freeEstimates ? "Free estimate" : "Ask for a price"}${icon("arrow-right")}</a></p>`;
    return html`<li class="svc">${itemHeading(level, "svc-name h3", service.name)}${price}${description && html`<p class="svc-desc">${description}</p>`}</li>`;
  });
  // Fixed house copy: it fits every trade (cleaning and lawn care have no "problem" to describe).
  const card = html`<div class="cta-card ink">
${itemHeading(level, "h3", "Not sure what you need?")}
<p>Call now, or tell us what you need in a quick request.</p>
<div class="cta-actions">${callButton(ctx, "action")}${contact && ctaButton(ctx)}</div>
</div>`;

  return band(
    ctx,
    "services",
    { eyebrow: "Services", title: "What we do", pageTitle: "Our services", intro: copy.sectionIntros.services },
    "wrap svc-layout",
    html`<ul class="board">${rows}</ul>
${card}`,
  );
}
