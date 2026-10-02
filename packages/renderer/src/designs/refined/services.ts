// Classic's services: a price list. Each name runs into a dotted leader that ends at its price. The name
// takes the whole width left beside the price, and the dots are drawn along its last line behind the
// name's own words, so they always start where the words end, even when a long name wraps, and always
// run at least 3rem. An unpriced service says "Price on request"; one light box after the list offers the
// owner's call to action for any other job, unless the closing band comes right after the list. Opening the
// Services page, the list's heading is the page's <h1> with the owner's proof (license, Insured, Free estimates)
// under the intro, where a visitor weighs the prices; when the owner puts the questions first, they open the page
// under "Our services" (faq.ts) and the list is "Services & prices".
import { headingLevel, quoteLink, type RenderContext } from "../../context.ts";
import { formatPrice } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { booksVisits, credentialLine, ctaLong, itemHeading, sectionHead, sectionTitle, TRADE_WORD } from "./parts.ts";
import { bandClass, plan } from "./plan.ts";

export function renderServices(ctx: RenderContext): SafeHtml {
  const { doc } = ctx;
  const { facts, copy } = doc;
  // SiteDocument guarantees serviceDescriptions[i] names facts.services[i].
  const items = facts.services.map((service, i) => {
    const description = copy.serviceDescriptions[i]?.description;
    const price =
      service.startingPrice === undefined ? html`<p class="pr pr-ask">Price on request</p>` : html`<p class="pr">From ${formatPrice(service.startingPrice)}</p>`;
    return html`<li class="svc"><div class="svc-l">${itemHeading(ctx, "services", "svc-n", html`<span>${service.name}</span>`)}${price}</div>${description !== undefined && html`<p class="svc-d">${description}</p>`}</li>`;
  });
  const unpriced = facts.services.some((service) => service.startingPrice === undefined);
  const title = booksVisits(doc) ? "Ready to book?" : unpriced ? "Need a price?" : "Need something else?";
  // The box is left out when the closing band, with the same call to action, comes right after the list.
  const more =
    plan(ctx).last !== "services" &&
    html`<li class="svc-more"><div><p class="svc-mt">${title}</p><p>Ask us about any ${TRADE_WORD[facts.trade]} job.</p></div><a class="bt bt-act" href="${quoteLink()}">${ctaLong(doc)}</a></li>`;

  return html`<section id="${DOM_ID.services}" class="sec ${bandClass(ctx, "services")}" aria-labelledby="${DOM_ID.services}-title">
<div class="wr">
${opensAfterQuestions(ctx) ? sectionHead(DOM_ID.services, "Services & prices") : sectionTitle(ctx, "services", "Our services", copy.sectionIntros.services, credentialLine(ctx, true))}
<ul class="svc-list">
${items}
${more}
</ul>
</div>
</section>`;
}

/** The owner put the questions before the price list on the Services page: they open it under "Our services". */
export const opensAfterQuestions = (ctx: RenderContext): boolean => ctx.page.id === "services" && headingLevel(ctx, "faq") === 1;
