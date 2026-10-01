// Ported from AstroWind (MIT, see THIRD_PARTY_NOTICES.md) src/components/widgets/Features2.astro
// at commit 14e1a69. Changes: service names and prices come from owner facts, descriptions from
// copy; the column count follows the number of services (lookup table, whole class strings);
// the invisible white border and no-op backdrop-blur are replaced by a visible gray border;
// a compact list variant is added for long service lists; dark:, intersect-* and fade removed.
import type { VariantOf } from "@asksite/site-schema";
import { headingLevel, type RenderContext } from "../context.ts";
import { formatPrice } from "../format.ts";
import { html, type SafeHtml } from "../html.ts";
import { icon } from "../icons.ts";
import { headline, itemHeading, sectionShell } from "../ui.ts";
import { DOM_ID } from "./ids.ts";

const CARD_GRID = {
  one: "mx-auto grid max-w-xl grid-cols-1 gap-6",
  two: "grid grid-cols-1 gap-6 sm:grid-cols-2",
  many: "grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3",
} as const;

/** The column classes of a card grid of `count` items. */
export function cardGrid(count: number): string {
  if (count === 1) return CARD_GRID.one;
  if (count === 2 || count === 4) return CARD_GRID.two;
  return CARD_GRID.many;
}

/** "From $89" under a service's name, when the owner gave a starting price. */
export function startingPrice(dollars: number | undefined): SafeHtml | false {
  return dollars !== undefined && html`<p class="mt-1 font-semibold text-primary">From ${formatPrice(dollars)}</p>`;
}

export function renderServices(ctx: RenderContext, variant: VariantOf<"services">): SafeHtml {
  const { facts, copy } = ctx.doc;
  const level = headingLevel(ctx, "services");
  // SiteDocument guarantees serviceDescriptions[i] names facts.services[i].
  const items = facts.services.map((service, i) => ({ ...service, description: copy.serviceDescriptions[i]?.description }));

  const list =
    variant === "cards"
      ? html`<ul class="${cardGrid(items.length)}">
${items.map((s) => html`<li class="flex flex-col rounded-lg border border-gray-200 bg-white p-6 shadow-[0_4px_30px_rgba(0,0,0,0.1)]">
${icon("circle-check", "mb-4 h-10 w-10 text-primary")}
${itemHeading(level, "text-xl font-bold text-heading", s.name)}
${startingPrice(s.startingPrice)}
${s.description && html`<p class="mt-2 text-pretty text-muted">${s.description}</p>`}
</li>`)}
</ul>`
      : html`<ul class="mx-auto grid max-w-5xl grid-cols-1 gap-x-12 gap-y-8 sm:grid-cols-2">
${items.map((s) => html`<li class="flex gap-4">
${icon("check", "mt-1 h-6 w-6 shrink-0 text-primary")}
<div class="min-w-0">
${itemHeading(level, "text-lg font-bold text-heading", s.name)}
${startingPrice(s.startingPrice)}
${s.description && html`<p class="mt-1 text-pretty text-muted">${s.description}</p>`}
</div>
</li>`)}
</ul>`;

  return sectionShell(DOM_ID.services, "7xl", html`${headline(DOM_ID.services, "Our services", copy.sectionIntros.services, level)}
${list}`);
}
