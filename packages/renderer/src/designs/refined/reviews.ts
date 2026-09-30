// Classic's reviews: the owner's pasted reviews only, under one heading. One pull quote, then letter
// cards whose rules and names share a line. The review the hero shows is left out here, so no review is
// ever on the page twice (the hero takes one only while at least one stays here).
import type { RenderContext } from "../../context.ts";
import { html, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { ctaRow, reviewer, sectionHead } from "./parts.ts";
import { plan } from "./plan.ts";

/** A pull quote longer than this gets the smaller size. */
const LONG_QUOTE = 180;

function gridClass(count: number): string {
  if (count === 1) return "qgrid qg-1";
  if (count === 2 || count === 4) return "qgrid qg-2";
  return count === 3 ? "qgrid qg-3" : "qgrid qg-n";
}

export function renderReviews(ctx: RenderContext): SafeHtml {
  const { heroQuote, band, ctaAfter } = plan(ctx);
  const [lead, ...rest] = ctx.doc.facts.testimonials.filter((_, i) => i !== heroQuote);
  const cards =
    rest.length > 0 &&
    html`<ul class="${gridClass(rest.length)}">
${rest.map((review) => html`<li class="qc"><figure><blockquote><p>${review.quote}</p></blockquote><figcaption>${reviewer(review)}</figcaption></figure></li>`)}
</ul>`;
  const pull =
    lead !== undefined &&
    html`<figure class="${lead.quote.length > LONG_QUOTE ? "lq lq-long" : "lq"}"><span class="qm" aria-hidden="true">“</span><blockquote><p>${lead.quote}</p></blockquote><figcaption>${reviewer(lead)}</figcaption></figure>`;
  // A pull quote and one card share a row from 64rem, instead of a lone card under the pull quote.
  const quotes = rest.length === 1 ? html`<div class="qpair">
${pull}
${cards}
</div>` : html`${pull}
${cards}`;

  return html`<section id="${DOM_ID.testimonials}" class="${band.testimonials === "white" ? "sec bw" : "sec bp"}" aria-labelledby="${DOM_ID.testimonials}-title">
<div class="wr">
${sectionHead(DOM_ID.testimonials, "What customers say")}
${quotes}
${ctaAfter === "testimonials" && ctaRow(ctx.doc)}
</div>
</section>`;
}
