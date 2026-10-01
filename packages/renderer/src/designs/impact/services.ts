// The Bold services: a menu board. Every row shares the same grid, so the dividers line up: the name, then the
// price cell in one style ("From $89", or a link to the form: "Free estimate" only when the owner gives them), then
// the description. Beside a list of more than three services (under it on phones) a card offers the call and the call
// to action; a shorter list is the board alone, as the closing band with the same pair follows close below. When the
// section names the Services page its heading is the page's <h1>, so the service names are h2s (A16: no heading
// level skipped). Home's preview (teaser.ts) draws the names and prices on the same board.
import type { Facts } from "@asksite/site-schema";
import { quoteLink, type RenderContext } from "../../context.ts";
import { formatPrice } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { itemHeading } from "../../ui.ts";
import { icon } from "./icons.ts";
import { band, callButton, ctaButton, itemLevel } from "./parts.ts";

/** One row of the board. */
function serviceRow(ctx: RenderContext, service: Facts["services"][number], description: string | undefined, level: 1 | 2): SafeHtml {
  const { freeEstimates } = ctx.doc.facts;
  const price =
    service.startingPrice !== undefined
      ? html`<p class="svc-price">From <span class="svc-amt display tnum">${formatPrice(service.startingPrice)}</span></p>`
      : html`<p class="svc-price"><a class="svc-ask" href="${quoteLink()}">${freeEstimates ? "Free estimate" : "Ask for a price"}${icon("arrow-right")}</a></p>`;
  return html`<li class="svc">${itemHeading(level, "svc-name h3", service.name)}${price}${description && html`<p class="svc-desc">${description}</p>`}</li>`;
}

/** The "Not sure what you need?" card: Call and the owner's call to action. Fixed house copy (it fits every trade: cleaning and lawn care have no "problem" to describe). */
function ctaCard(ctx: RenderContext, level: 1 | 2): SafeHtml {
  return html`<div class="cta-card ink">
${itemHeading(level, "h3", "Not sure what you need?")}
<p>Call now, or tell us what you need in a quick request.</p>
<div class="cta-actions">${callButton(ctx, "action")}${ctaButton(ctx)}</div>
</div>`;
}

/** The longest list drawn without the card beside it. */
const SHORT_LIST = 3;

export function renderServices(ctx: RenderContext): SafeHtml {
  const { facts, copy } = ctx.doc;
  const level = itemLevel(ctx, "services");
  // SiteDocument guarantees serviceDescriptions[i] names facts.services[i].
  const rows = facts.services.map((service, i) => serviceRow(ctx, service, copy.serviceDescriptions[i]?.description, level));
  const card = rows.length > SHORT_LIST;
  return band(
    ctx,
    "services",
    { eyebrow: "Services", title: "What we do", pageTitle: "Our services", intro: copy.sectionIntros.services },
    card ? "wrap svc-layout" : "wrap svc-layout svc-layout--solo",
    html`<div class="svc-main"><ul class="board">${rows}</ul></div>
${card && ctaCard(ctx, level)}`,
  );
}
