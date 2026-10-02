// Classic's questions and answers: an exclusive <details name="faq"> accordion (or an open list), and a
// "Still have a question?" Call box, under the heading on wide screens and after the questions on phones (left out
// there when the closing band, with its own Call, comes right after). When the owner puts the questions first on the
// Services page, the page still opens as the Services page: its eyebrow, the <h1> "Our services", the services intro
// and the owner's proof, then the questions under their own h2.
import type { VariantOf } from "@asksite/site-schema";
import type { RenderContext } from "../../context.ts";
import { formatPhone, telUrl } from "../../format.ts";
import { html, trusted, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { credentialLine, icon, pageHead, sectionHead } from "./parts.ts";
import { bandClass, plan } from "./plan.ts";
import { opensAfterQuestions } from "./services.ts";

export function renderFaq(ctx: RenderContext, variant: VariantOf<"faq">): SafeHtml {
  const { facts, copy } = ctx.doc;
  const list =
    variant === "accordion"
      ? html`<div class="faq-l">
${copy.faq.map((item, i) => html`<details class="faq-i" name="faq"${i === 0 && trusted(" open")}><summary><h3 class="faq-q">${item.question}</h3><span class="faq-t">${icon("plus")}</span></summary><p class="faq-a">${item.answer}</p></details>`)}
</div>`
      : html`<ul class="faq-o">
${copy.faq.map((item) => html`<li><h3 class="faq-q">${item.question}</h3><p class="faq-a">${item.answer}</p></li>`)}
</ul>`;
  const opener = opensAfterQuestions(ctx) && pageHead(ctx, "Our services", { intro: copy.sectionIntros.services, after: credentialLine(ctx, true) });

  return html`<section id="${DOM_ID.faq}" class="sec ${bandClass(ctx, "faq")}" aria-labelledby="${DOM_ID.faq}-title">
${opener && html`<div class="wr">
${opener}
</div>`}
<div class="wr faq">
${sectionHead(DOM_ID.faq, "Questions & answers", copy.sectionIntros.faq)}
${list}
<div class="${plan(ctx).last === "faq" ? "ask ask-l" : "ask"}"><p>Still have a question?</p><a class="bt bt-act whitespace-nowrap" href="${telUrl(facts.phone)}">${icon("phone")}Call ${formatPhone(facts.phone)}</a></div>
</div>
</section>`;
}
