// Service area and hours (new; AstroWind has no such section). Everything here is an owner fact:
// the subtitle is the owner's service-area note, never AI prose. Place chips may wrap anywhere,
// so one long unbroken place name cannot push the page sideways at 320 px. The matching
// LocalBusiness JSON-LD (areaServed, openingHoursSpecification) is emitted once by render.ts.
import type { VariantOf } from "@asksite/site-schema";
import type { RenderContext } from "../context.ts";
import { weeklyHours } from "../format.ts";
import { html, type SafeHtml } from "../html.ts";
import { icon } from "../icons.ts";
import { headline, sectionShell } from "../ui.ts";
import { DOM_ID } from "./ids.ts";

const COLUMNS = {
  withHours: "mx-auto grid max-w-5xl grid-cols-1 gap-10 md:grid-cols-2",
  placesOnly: "mx-auto max-w-3xl",
} as const;

const TITLE = { withHours: "Service area & hours", placesOnly: "Service area" } as const;

export function renderServiceArea(ctx: RenderContext, _variant: VariantOf<"serviceArea">): SafeHtml {
  const { facts } = ctx.doc;
  const { location, serviceArea } = facts;
  const hasHours = facts.hours.length > 0;
  const cityLine = `${location.city}, ${location.state}${location.postalCode ? ` ${location.postalCode}` : ""}`;

  return sectionShell(DOM_ID.serviceArea, "7xl", html`${headline(DOM_ID.serviceArea, hasHours ? TITLE.withHours : TITLE.placesOnly, serviceArea.note)}
<div class="${hasHours ? COLUMNS.withHours : COLUMNS.placesOnly}">
<div>
<h3 class="flex items-center gap-2 text-xl font-bold text-heading">${icon("map-pin", "h-6 w-6 shrink-0 text-primary")}Areas we serve</h3>
<ul class="mt-4 flex flex-wrap gap-2">
${serviceArea.places.map((place) => html`<li class="max-w-full rounded-full border border-gray-300 px-3 py-1 text-sm text-default wrap-anywhere">${place}</li>`)}
</ul>
${location.streetAddress
  ? html`<address class="mt-6 text-default not-italic">${location.streetAddress}<br>${cityLine}</address>`
  : html`<p class="mt-6 text-default">Based in ${cityLine}</p>`}
</div>
${hasHours && html`<div>
<h3 class="flex items-center gap-2 text-xl font-bold text-heading">${icon("clock", "h-6 w-6 shrink-0 text-primary")}Hours</h3>
<table class="mt-4 w-full text-left">
<tbody>
${weeklyHours(facts.hours).map((row) => html`<tr class="border-b border-gray-200"><th scope="row" class="py-2 pr-4 font-medium text-heading">${row.day}</th><td class="py-2 text-default">${row.time}</td></tr>`)}
</tbody>
</table>
${facts.emergency247 && html`<p class="mt-4 font-semibold text-heading">24/7 emergency service available</p>`}
</div>`}
</div>`);
}
