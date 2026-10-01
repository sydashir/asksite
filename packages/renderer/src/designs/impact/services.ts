// The Bold services: a menu board. Every row shares the same grid, so the dividers line up: the name, then the
// price cell in one style ("From $89", or a link to the form: "Free estimate" only when the owner gives them), then
// the description. A card beside the board (under it on phones) offers the call and the call to action. When the
// section names the Services page its heading is the page's <h1>, so the service names are h2s (A16: no heading
// level skipped). Home's preview (teaser.ts) draws the same rows.
import type { Facts } from "@asksite/site-schema";
import { quoteLink, type RenderContext } from "../../context.ts";
import { formatPrice } from "../../format.ts";
import { html, type SafeHtml, type SafeUrl } from "../../html.ts";
import { itemHeading } from "../../ui.ts";
import { icon } from "./icons.ts";
import { band, callButton, ctaButton, itemLevel } from "./parts.ts";

/**
 * One row of the board. With `link` (Home's preview) the name leads to the Services page and the whole row is its
 * target; the price cell's own link to the form stays on top of it.
 */
export function serviceRow(ctx: RenderContext, service: Facts["services"][number], description: string | undefined, level: 1 | 2, link?: SafeUrl): SafeHtml {
  const { freeEstimates } = ctx.doc.facts;
  const price =
    service.startingPrice !== undefined
      ? html`<p class="svc-price">From <span class="svc-amt display tnum">${formatPrice(service.startingPrice)}</span></p>`
      : html`<p class="svc-price"><a class="svc-ask" href="${quoteLink()}">${freeEstimates ? "Free estimate" : "Ask for a price"}${icon("arrow-right")}</a></p>`;
  const name = link === undefined ? service.name : html`<a class="svc-go" href="${link}">${service.name}</a>`;
  return html`<li class="${link === undefined ? "svc" : "svc svc--go"}">${itemHeading(level, "svc-name h3", name)}${price}${description && html`<p class="svc-desc">${description}</p>`}</li>`;
}

/** The "Not sure what you need?" card: Call and the owner's call to action. Fixed house copy (it fits every trade: cleaning and lawn care have no "problem" to describe). */
export function ctaCard(ctx: RenderContext, level: 1 | 2, classes: "cta-card ink" | "cta-card cta-card--home ink" = "cta-card ink"): SafeHtml {
  return html`<div class="${classes}">
${itemHeading(level, "h3", "Not sure what you need?")}
<p>Call now, or tell us what you need in a quick request.</p>
<div class="cta-actions">${callButton(ctx, "action")}${ctaButton(ctx)}</div>
</div>`;
}

export function renderServices(ctx: RenderContext): SafeHtml {
  const { facts, copy } = ctx.doc;
  const level = itemLevel(ctx, "services");
  // SiteDocument guarantees serviceDescriptions[i] names facts.services[i].
  const rows = facts.services.map((service, i) => serviceRow(ctx, service, copy.serviceDescriptions[i]?.description, level));
  return band(
    ctx,
    "services",
    { eyebrow: "Services", title: "What we do", pageTitle: "Our services", intro: copy.sectionIntros.services },
    "wrap svc-layout",
    html`<div class="svc-main"><ul class="board">${rows}</ul></div>
${ctaCard(ctx, level)}`,
  );
}
