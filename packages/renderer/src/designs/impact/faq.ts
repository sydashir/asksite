// The Bold FAQ: the heading at the left (with the call prompt under it from 64rem), the questions at the right.
// The accordion is native <details name="faq"> (one open at a time, no JavaScript); the "open" variant shows
// every answer. When the owner puts it first on the Services page, the page's head (its <h1> "Our services") opens
// the band and the FAQ keeps its own heading (A16, U1).
import type { VariantOf } from "@asksite/site-schema";
import type { RenderContext } from "../../context.ts";
import { html, trusted, type SafeHtml } from "../../html.ts";
import { itemHeading } from "../../ui.ts";
import { icon } from "./icons.ts";
import { band, callButton, itemLevel } from "./parts.ts";

export function renderFaq(ctx: RenderContext, variant: VariantOf<"faq">): SafeHtml {
  const { copy } = ctx.doc;
  const level = itemLevel(ctx, "faq");
  const items =
    variant === "accordion"
      ? copy.faq.map(
          (item, i) =>
            html`<details class="faq" name="faq"${i === 0 && trusted(" open")}><summary>${itemHeading(level, "h3", item.question)}<span class="faq-ic">${icon("plus", "ic ic-plus")}${icon("minus", "ic ic-minus")}</span></summary><p class="faq-a">${item.answer}</p></details>`,
        )
      : copy.faq.map((item) => html`<div class="faq faq--open">${itemHeading(level, "h3", item.question)}<p class="faq-a">${item.answer}</p></div>`);

  return band(
    ctx,
    "faq",
    { eyebrow: "FAQ", title: "Questions & answers", intro: copy.sectionIntros.faq },
    "wrap faq-layout",
    html`<div class="faq-list">${items}</div>
<p class="faq-call"><span>Still have a question?</span>${callButton(ctx, "ghost")}</p>`,
  );
}
