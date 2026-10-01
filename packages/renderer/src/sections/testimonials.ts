// Ported from AstroWind (MIT, see THIRD_PARTY_NOTICES.md) src/components/widgets/Testimonials.astro
// at commit 14e1a69. Changes: quotes are owner-pasted facts (never AI) shown as escaped text in
// <figure>/<blockquote>/<figcaption> under a fixed heading with no AI subtitle, so AI prose never
// frames real reviews; star ratings, logos, avatars and call-to-action dropped;
// one or two reviews use a narrower grid instead of leaving empty columns; dark:, intersect-*
// and fade classes removed.
import type { VariantOf } from "@asksite/site-schema";
import { headingLevel, type RenderContext } from "../context.ts";
import { html, type SafeHtml } from "../html.ts";
import { headline, sectionShell } from "../ui.ts";
import { DOM_ID } from "./ids.ts";

const LAYOUT = {
  one: { list: "mx-auto grid max-w-xl grid-cols-1 gap-6", item: "flex" },
  two: { list: "grid grid-cols-1 gap-6 sm:grid-cols-2", item: "flex" },
  grid: { list: "grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3", item: "flex" },
  masonry: { list: "columns-1 gap-6 sm:columns-2 lg:columns-3", item: "mb-6 flex break-inside-avoid" },
} as const;

export function renderTestimonials(ctx: RenderContext, variant: VariantOf<"testimonials">): SafeHtml {
  const { facts } = ctx.doc;
  const count = facts.testimonials.length;
  const layout = count === 1 ? LAYOUT.one : count === 2 ? LAYOUT.two : LAYOUT[variant];

  return sectionShell(DOM_ID.testimonials, "6xl", html`${headline(DOM_ID.testimonials, "What customers say", undefined, headingLevel(ctx, "testimonials"))}
<ul class="${layout.list}">
${facts.testimonials.map((t) => html`<li class="${layout.item}">
<figure class="flex w-full flex-col rounded-md bg-white p-4 shadow-xl md:p-6">
<blockquote class="flex-auto"><p class="text-muted before:content-['“'] after:content-['”']">${t.quote}</p></blockquote>
<hr class="my-4 border-slate-200">
<figcaption>
<p class="font-semibold text-heading">${t.name}</p>
${t.location && html`<p class="text-sm text-muted">${t.location}</p>`}
</figcaption>
</figure>
</li>`)}
</ul>`);
}
