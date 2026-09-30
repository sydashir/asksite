// The Bold service area and hours: one white panel with the towns served and the address, and the hours
// beside them. Hours never break inside a time or a day range (no-break spaces, rules.ts).
import type { RenderContext } from "../../context.ts";
import { formatPhone, telUrl } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { icon } from "./icons.ts";
import { bandClass, sectionHead } from "./parts.ts";
import { groupedHours } from "./rules.ts";

export function renderServiceArea(ctx: RenderContext): SafeHtml {
  const { facts } = ctx.doc;
  const { location, serviceArea } = facts;
  const hasHours = facts.hours.length > 0;
  const cityLine = `${location.city}, ${location.state}${location.postalCode === undefined ? "" : ` ${location.postalCode}`}`;
  const address = location.streetAddress
    ? html`<address class="addr">${location.streetAddress}<br>${cityLine}</address>`
    : html`<p class="addr">Based in ${cityLine}</p>`;
  const emergency =
    facts.emergency247 &&
    html`<p class="em">${icon("phone")}<span>24/7 emergency calls:</span> <a class="whitespace-nowrap" href="${telUrl(facts.phone)}">${formatPhone(facts.phone)}</a></p>`;
  const places = html`<div class="area-col"><h3 class="h3">${icon("map-pin")}Areas we serve</h3><ul class="chips">${serviceArea.places.map((p) => html`<li>${p}</li>`)}</ul>${address}${!hasHours && emergency}</div>`;
  const hours =
    hasHours &&
    html`<div class="area-col hours-col"><h3 class="h3">${icon("clock")}Hours</h3><dl class="hours">${groupedHours(facts.hours).map((r) => (r.value === "Closed" ? html`<div class="hrow closed"><dt>${r.label}</dt><dd>${r.value}</dd></div>` : html`<div class="hrow"><dt>${r.label}</dt><dd>${r.value}</dd></div>`))}</dl>${emergency}</div>`;

  return html`<section id="${DOM_ID.serviceArea}" class="${bandClass(ctx, "serviceArea")}" aria-labelledby="${DOM_ID.serviceArea}-title">
<div class="${hasHours ? "wrap" : "wrap area-wrap--one"}">
${sectionHead("serviceArea", hasHours ? "Service area & hours" : "Service area", "Where we work", serviceArea.note)}
<div class="${hasHours ? "area card" : "area area--one card"}">${places}${hours}</div>
</div>
</section>`;
}
