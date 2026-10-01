// Ported from AstroWind (MIT, see THIRD_PARTY_NOTICES.md) src/components/widgets/FAQs.astro
// at commit 14e1a69. Changes: the random <details name> group (Math.random, line 31) is the
// fixed name "faq"; questions and answers are escaped text, not set:html; the FAQPage JSON-LD
// is built from data and serialised safely in render.ts (the original only stripped tags);
// rtl:, dark:, intersect-* and fade classes removed; flex-shrink-0 written as shrink-0.
import type { VariantOf } from "@asksite/site-schema";
import { headingLevel, type RenderContext } from "../context.ts";
import { html, trusted, type SafeHtml } from "../html.ts";
import { icon } from "../icons.ts";
import { headline, itemHeading, sectionShell } from "../ui.ts";
import { DOM_ID } from "./ids.ts";

export function renderFaq(ctx: RenderContext, variant: VariantOf<"faq">): SafeHtml {
  const { copy } = ctx.doc;
  const level = headingLevel(ctx, "faq");

  const list =
    variant === "accordion"
      ? html`<div class="mx-auto max-w-3xl divide-y divide-gray-200">
${copy.faq.map((item, i) => html`<details class="group" name="faq"${i === 0 && trusted(" open")}>
<summary class="flex cursor-pointer list-none items-center justify-between gap-4 py-5 outline-offset-4 [&::-webkit-details-marker]:hidden">
${itemHeading(level, "min-w-0 text-lg font-semibold text-heading md:text-xl", item.question)}
${icon("chevron-down", "h-6 w-6 shrink-0 text-primary transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none")}
</summary>
<div class="pr-10 pb-5"><p class="text-muted">${item.answer}</p></div>
</details>`)}
</div>`
      : html`<div class="mx-auto grid max-w-4xl grid-cols-1 gap-8 sm:grid-cols-2 md:gap-y-8">
${copy.faq.map((item) => html`<div class="flex flex-row">
<div class="flex justify-center">${icon("chevron-right", "mt-1 mr-2 h-6 w-6 shrink-0 text-primary")}</div>
<div class="mt-0.5 min-w-0">
${itemHeading(level, "text-xl font-bold text-heading", item.question)}
<p class="mt-3 text-muted">${item.answer}</p>
</div>
</div>`)}
</div>`;

  return sectionShell(DOM_ID.faq, "7xl", html`${headline(DOM_ID.faq, "Questions & answers", copy.sectionIntros.faq, level)}
${list}`);
}
