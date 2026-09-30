// The Bold FAQ: the heading at the left (with the call prompt under it from 64rem), the questions at the right.
// The accordion is native <details name="faq"> (one open at a time, no JavaScript); the "open" variant shows
// every answer.
import type { VariantOf } from "@asksite/site-schema";
import type { RenderContext } from "../../context.ts";
import { html, trusted, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { icon } from "./icons.ts";
import { bandClass, callButton, sectionHead } from "./parts.ts";

export function renderFaq(ctx: RenderContext, variant: VariantOf<"faq">): SafeHtml {
  const { copy } = ctx.doc;
  const items =
    variant === "accordion"
      ? copy.faq.map(
          (item, i) =>
            html`<details class="faq" name="faq"${i === 0 && trusted(" open")}><summary><h3 class="h3">${item.question}</h3><span class="faq-ic">${icon("plus", "ic ic-plus")}${icon("minus", "ic ic-minus")}</span></summary><p class="faq-a">${item.answer}</p></details>`,
        )
      : copy.faq.map((item) => html`<div class="faq faq--open"><h3 class="h3">${item.question}</h3><p class="faq-a">${item.answer}</p></div>`);

  return html`<section id="${DOM_ID.faq}" class="${bandClass(ctx, "faq")}" aria-labelledby="${DOM_ID.faq}-title">
<div class="wrap faq-layout">
${sectionHead("faq", "FAQ", "Questions & answers", copy.sectionIntros.faq)}
<div class="faq-list">${items}</div>
<p class="faq-call"><span>Still have a question?</span>${callButton(ctx, "ghost")}</p>
</div>
</section>`;
}
