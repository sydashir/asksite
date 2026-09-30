// Classic's services: a price list. Each name runs into a dotted leader that ends at its price. The name
// takes the whole width left beside the price, and the dots are drawn along its last line behind the
// name's own words, so they always start where the words end, even when a long name wraps, and always
// run at least 3rem. An unpriced service says "Price on request"; one box after the list offers the
// owner's call to action for any other job.
import type { RenderContext } from "../../context.ts";
import { formatPrice } from "../../format.ts";
import { fragment, html, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { booksVisits, ctaLong, sectionHead, TRADE_WORD } from "./parts.ts";
import { plan } from "./plan.ts";

export function renderServices(ctx: RenderContext): SafeHtml {
  const { doc } = ctx;
  const { facts, copy } = doc;
  const { band: bands, beforeForm } = plan(ctx);
  const band = bands.services === "white" ? "sec bw" : "sec bp";
  // SiteDocument guarantees serviceDescriptions[i] names facts.services[i].
  const items = facts.services.map((service, i) => {
    const description = copy.serviceDescriptions[i]?.description;
    const price =
      service.startingPrice === undefined ? html`<p class="pr pr-ask">Price on request</p>` : html`<p class="pr">From ${formatPrice(service.startingPrice)}</p>`;
    return html`<li class="svc"><div class="svc-l"><h3 class="svc-n"><span>${service.name}</span></h3>${price}</div>${description !== undefined && html`<p class="svc-d">${description}</p>`}</li>`;
  });
  const unpriced = facts.services.some((service) => service.startingPrice === undefined);
  const title = booksVisits(doc) ? "Ready to book?" : unpriced ? "Need a price?" : "Need something else?";
  // The box is left out when the contact form is the next thing on the page.
  const more =
    beforeForm !== "services" &&
    html`<li class="svc-more"><div><p class="svc-mt">${title}</p><p>Ask us about any ${TRADE_WORD[facts.trade]} job.</p></div><a class="bt bt-act" href="${fragment("contact-form")}">${ctaLong(doc)}</a></li>`;

  return html`<section id="${DOM_ID.services}" class="${band}" aria-labelledby="${DOM_ID.services}-title">
<div class="wr">
${sectionHead(DOM_ID.services, "Our services", copy.sectionIntros.services)}
<ul class="svc-list">
${items}
${more}
</ul>
</div>
</section>`;
}
