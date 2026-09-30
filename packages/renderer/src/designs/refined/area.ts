// Classic's service area: the owner's towns in balanced columns beside a paper card with the hours (or,
// when the hero's business card already lists them, the owner's base) and the 24/7 note. Everything
// here is an owner fact; the intro is the owner's own area note. One town with nothing else to show is
// one line (Plan.areaFold).
import type { RenderContext } from "../../context.ts";
import { formatPhone, telUrl } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { dots, hoursList, hoursTitle, icon, sectionHead } from "./parts.ts";
import { plan } from "./plan.ts";

/**
 * Columns for n towns, at most max. CSS columns fill in turn, ceil(n/c) towns each, so the last column
 * holds what is left: c is kept only when that is at least 2 towns (or every column holds 1) and not far
 * short of the others (4/4/2 is fine; 3/3/1 and 2/2/1 are not).
 */
export function placeColumns(n: number, max: number): number {
  for (let c = Math.min(max, n); c >= 2; c--) {
    const each = Math.ceil(n / c);
    const last = n - (c - 1) * each;
    if (last > 0 && (last === each || (last >= 2 && last >= each - 2))) return c;
  }
  return 1;
}

function placesClass(n: number): string {
  const phone = placeColumns(n, 2) === 1 ? " pc-1" : "";
  const wide = placeColumns(n, 3);
  return `places${phone}${wide === 3 ? "" : ` pw-${wide}`}`;
}

/**
 * The one town, and the owner's base when it is another town or a street address, as one line under a small
 * heading, so the section does not repeat the hero's card in two columns (the approved mockup's fold).
 */
function areaLine(ctx: RenderContext): SafeHtml {
  const { location, serviceArea } = ctx.doc.facts;
  const place = serviceArea.places[0] ?? location.city;
  const home = place.trim().toLowerCase() === location.city.trim().toLowerCase();
  const cityLine = `${location.city}, ${location.state}`;
  // The town is said once: a street address in the town served gives only the street (the contact band has it in full).
  const street = location.streetAddress;
  const base = street ? (home ? street : `${street}, ${cityLine}${location.postalCode ? ` ${location.postalCode}` : ""}`) : home ? undefined : `Based in ${cityLine}`;
  const items = [{ text: `Serving ${home ? cityLine : place}` }, ...(base === undefined ? [] : [{ text: base }])];
  return html`<section id="${DOM_ID.serviceArea}" class="${plan(ctx).band.serviceArea === "white" ? "af bw" : "af bp"}" aria-labelledby="${DOM_ID.serviceArea}-title">
<div class="wr">
<h2 id="${DOM_ID.serviceArea}-title" class="h3r">${icon("map-pin")}Service area</h2>
<p class="af-l">${dots(items)}</p>
</div>
</section>`;
}

export function renderServiceArea(ctx: RenderContext): SafeHtml {
  if (plan(ctx).areaFold) return areaLine(ctx);
  const { facts } = ctx.doc;
  const { location, serviceArea } = facts;
  const hasHours = facts.hours.length > 0 && !plan(ctx).cardHours;
  const cityLine = `${location.city}, ${location.state}${location.postalCode ? ` ${location.postalCode}` : ""}`;
  const base = location.streetAddress
    ? html`<address class="addr">${icon("store")}<span>${location.streetAddress}<br>${cityLine}</span></address>`
    : html`<p class="addr">${icon("store")}<span>Based in ${cityLine}</span></p>`;
  const note247 =
    facts.emergency247 &&
    html`<p class="h247"><strong>${icon("clock")}24/7 emergency service available</strong><a class="whitespace-nowrap" href="${telUrl(facts.phone)}">Call ${formatPhone(facts.phone)}</a></p>`;
  const card = hasHours
    ? html`<div class="hcard">
<h3 class="h3r">${icon("clock")}${hoursTitle(facts)}</h3>
<dl class="hours">
${hoursList(facts.hours)}
</dl>
${note247}
</div>`
    : html`<div class="hcard">
<h3 class="h3r">${icon("store")}Where we’re based</h3>
${location.streetAddress ? html`<address class="base">${location.streetAddress}<br>${cityLine}</address>` : html`<p class="base">${cityLine}</p>`}
${note247}
</div>`;

  return html`<section id="${DOM_ID.serviceArea}" class="${plan(ctx).band.serviceArea === "white" ? "sec bw" : "sec bp"}" aria-labelledby="${DOM_ID.serviceArea}-title">
<div class="wr">
${sectionHead(DOM_ID.serviceArea, hasHours ? "Service area & hours" : "Service area", serviceArea.note)}
<div class="area">
<div>
<h3 class="h3r">${icon("map-pin")}Areas we serve</h3>
<ul class="${placesClass(serviceArea.places.length)}">
${serviceArea.places.map((place) => html`<li>${place}</li>`)}
</ul>
${hasHours && base}
</div>
${card}
</div>
</div>
</section>`;
}
