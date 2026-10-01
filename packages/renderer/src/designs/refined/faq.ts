// Classic's questions and answers: an exclusive <details name="faq"> accordion (or an open list), and a
// "Still have a question?" Call box, under the heading on wide screens and after the questions on phones.
import type { VariantOf } from "@asksite/site-schema";
import type { RenderContext } from "../../context.ts";
import { formatPhone, telUrl } from "../../format.ts";
import { html, trusted, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { icon, itemHeading, sectionTitle } from "./parts.ts";
import { bandClass } from "./plan.ts";

export function renderFaq(ctx: RenderContext, variant: VariantOf<"faq">): SafeHtml {
  const { facts, copy } = ctx.doc;
  const list =
    variant === "accordion"
      ? html`<div class="faq-l">
${copy.faq.map((item, i) => html`<details class="faq-i" name="faq"${i === 0 && trusted(" open")}><summary>${itemHeading(ctx, "faq", "faq-q", item.question)}<span class="faq-t">${icon("plus")}</span></summary><p class="faq-a">${item.answer}</p></details>`)}
</div>`
      : html`<ul class="faq-o">
${copy.faq.map((item) => html`<li>${itemHeading(ctx, "faq", "faq-q", item.question)}<p class="faq-a">${item.answer}</p></li>`)}
</ul>`;

  return html`<section id="${DOM_ID.faq}" class="sec ${bandClass(ctx, "faq")}" aria-labelledby="${DOM_ID.faq}-title">
<div class="wr faq">
${sectionTitle(ctx, "faq", "Questions & answers", copy.sectionIntros.faq)}
${list}
<div class="ask"><p>Still have a question?</p><a class="bt bt-act whitespace-nowrap" href="${telUrl(facts.phone)}">${icon("phone")}Call ${formatPhone(facts.phone)}</a></div>
</div>
</section>`;
}
