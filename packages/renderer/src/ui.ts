// Shared building blocks ported from AstroWind (MIT, see THIRD_PARTY_NOTICES.md) at commit
// 14e1a69: src/components/ui/Headline.astro and WidgetWrapper.astro. Changes from the original:
// - tailwind-merge results are written out as literal class strings (no runtime merging);
// - set:html replaced by escaped text via the html template;
// - dark:, intersect-* and fade classes dropped (they only work with JavaScript);
// - leading-tighter (produces no CSS in Tailwind 4.3.3) replaced by leading-tight.
import { html, type SafeHtml, type Value } from "./html.ts";

export type ContainerWidth = "6xl" | "7xl";

const CONTAINER: Record<ContainerWidth, string> = {
  "7xl": "relative mx-auto max-w-7xl px-4 py-12 text-default md:px-6 md:py-16 lg:py-20",
  "6xl": "relative mx-auto max-w-6xl px-4 py-12 text-default md:px-6 md:py-16 lg:py-20",
};

/** Section heading block. The h2 id is `${domId}-title`, which sectionShell uses for aria-labelledby. */
export function headline(domId: string, title: Value, subtitle?: string): SafeHtml {
  return html`<div class="mb-8 max-w-3xl text-center md:mx-auto md:mb-12">
<h2 id="${domId}-title" class="font-heading text-3xl font-bold leading-tight tracking-tighter text-balance text-heading md:text-4xl">${title}</h2>
${subtitle && html`<p class="mt-4 text-xl text-pretty text-muted">${subtitle}</p>`}
</div>`;
}

/** A landmark section labelled by its headline, with AstroWind's container spacing. */
export function sectionShell(domId: string, width: ContainerWidth, content: SafeHtml): SafeHtml {
  return html`<section id="${domId}" aria-labelledby="${domId}-title">
<div class="${CONTAINER[width]}">
${content}
</div>
</section>`;
}
