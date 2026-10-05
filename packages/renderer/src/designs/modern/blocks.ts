// The two blocks render.ts adds around a page's sections (A16), in Modern's language: Home's preview of the first
// services, and the closing band that ends every page but Contact. Neither is a layout section: no hide switch, and
// no AI text of its own (each shows copy the site already shows: the owner's lines about its services, and the call
// to action the hero shows too).
import { onSite, pageLink, type RenderContext } from "../../context.ts";
import { html, type SafeHtml } from "../../html.ts";
import { icon } from "../../icons.ts";
import { CLOSING_BAND_ID, SERVICES_PREVIEW_ID } from "../../sections/ids.ts";
import { areaItem, callButton, credentialLine, emergencyItem, freeEstimatesItem, fromPrice, head, quoteButton } from "./parts.ts";
import { needQuestion } from "./text.ts";

/** How many services Home previews. */
const PREVIEW_COUNT = 3;

// The preview's layout from 768 px: one service beside the heading, two or three in a row of columns.
const PREVIEW = { 1: "wrap teaser teaser--1", 2: "wrap teaser teaser--2", 3: "wrap teaser" } as const;

/**
 * Home's services preview: the first three services in the owner's order, each a ticked column with its name, its
 * "From $N" price when it has one (a service without one shows no price line: moderator answer (a)) and the owner's own
 * line about it. No column is boxed like a card, since none is a link: the one link, to the Services page, is the
 * button level with the heading, and when the owner has more services than the preview shows, a count sits beside it.
 * On phones each service is one ruled row, its price at the end of the name's line.
 */
export function renderServicesPreview(ctx: RenderContext, tone: string): SafeHtml {
  const { facts, copy } = ctx.doc;
  // SiteDocument guarantees serviceDescriptions[i] names facts.services[i].
  const items = facts.services.slice(0, PREVIEW_COUNT).map((s, i) => ({ ...s, description: copy.serviceDescriptions[i]?.description }));
  const count = facts.services.length > items.length && html`<p class="teaser-count">Showing ${items.length} of ${facts.services.length} services</p>`;
  return html`<section id="${SERVICES_PREVIEW_ID}" class="sec teaser-sec ${tone}" aria-labelledby="${SERVICES_PREVIEW_ID}-title">
<div class="${PREVIEW[items.length as keyof typeof PREVIEW]}">
${head(SERVICES_PREVIEW_ID, "Our services")}
<ul class="teaser-list">
${items.map((s) => html`<li>${icon("check", "i")}<h3 class="h3">${s.name}</h3>${fromPrice(s.startingPrice)}${s.description && html`<p class="teaser-desc">${s.description}</p>`}</li>`)}
</ul>
<div class="teaser-end">${count}<a class="button button-line" href="${pageLink(ctx, "services")}">More about our services${icon("chevron-right", "i")}</a></div>
</div>
</section>`;
}

/**
 * The closing band: a white card with the brand rule, the page's last call to action. Its heading, "Get in touch",
 * sits over the owner's own question (the trade and the home town: "Need a plumber in Austin?") and a reason to act
 * from the owner's facts (24/7 service, as the hero says it; free estimates, one of the credentials, so only while
 * the site shows them; with neither, the towns the business serves while the site shows them), beside (from
 * 1024 px) the Call button, in the action colour with the number, and the owner's call to action, to the quote form
 * (from 768 px: on phones the call bar carries the quote link, the moderator's quote rule, A16 round 6).
 * White on every page, so it never stacks on the brand-coloured footer as a second footer (judges, A16 round 2).
 */
export function renderClosingBand(ctx: RenderContext, tone: string): SafeHtml {
  const { facts } = ctx.doc;
  const strengths = [...(facts.emergency247 ? [emergencyItem()] : []), ...(facts.freeEstimates && onSite(ctx, "trust") ? [freeEstimatesItem()] : [])];
  const reasons = strengths.length > 0 || !onSite(ctx, "serviceArea") ? strengths : [areaItem(facts)];
  return html`<section id="${CLOSING_BAND_ID}" class="sec close ${tone}" aria-labelledby="${CLOSING_BAND_ID}-title">
<div class="wrap">
<div class="close-card">
<div class="head">
<h2 id="${CLOSING_BAND_ID}-title" class="close-k">Get in touch</h2>
<p class="display h2">${needQuestion(facts)}</p>
${credentialLine(reasons)}
</div>
<div class="close-cta">${callButton(facts, "button-lg")}${quoteButton(ctx, "button-lg")}</div>
</div>
</div>
</section>`;
}
