// The Bold service area and hours: one white panel with the towns served and the address, and the hours
// beside them, at every width. Hours never break inside a time or a day range (no-break spaces, rules.ts). A long
// list shows its first 12 towns and the rest behind "+N more areas" (a native <details>, no JavaScript), so the
// form below is never pushed far down. When the owner puts this section first on the Contact page its heading is the
// page's <h1>, on the head band that also carries the number and the owner's call to action (A16, U1).
import type { RenderContext } from "../../context.ts";
import { formatPhone, telUrl } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { itemHeading } from "../../ui.ts";
import { icon } from "./icons.ts";
import { band, itemLevel } from "./parts.ts";
import { groupedHours } from "./rules.ts";

/** The towns shown before "+N more areas". */
const SHOWN_PLACES = 12;

export function renderServiceArea(ctx: RenderContext): SafeHtml {
  const { facts } = ctx.doc;
  const { location, serviceArea } = facts;
  const level = itemLevel(ctx, "serviceArea");
  const hasHours = facts.hours.length > 0;
  const cityLine = `${location.city}, ${location.state}${location.postalCode === undefined ? "" : ` ${location.postalCode}`}`;
  const address = location.streetAddress
    ? html`<address class="addr">${location.streetAddress}<br>${cityLine}</address>`
    : html`<p class="addr">Based in ${cityLine}</p>`;
  const emergency =
    facts.emergency247 &&
    html`<p class="em">${icon("phone")}<span>24/7 emergency calls:</span> <a class="whitespace-nowrap" href="${telUrl(facts.phone)}">${formatPhone(facts.phone)}</a></p>`;
  const shown = serviceArea.places.slice(0, SHOWN_PLACES);
  const more = serviceArea.places.slice(SHOWN_PLACES);
  const chips = (list: readonly string[]) => html`<ul class="chips">${list.map((p) => html`<li>${p}</li>`)}</ul>`;
  const places = html`<div class="area-col">${itemHeading(level, "h3", html`${icon("map-pin")}Areas we serve`)}${chips(shown)}${more.length > 0 && html`<details class="more-places"><summary>+${more.length} more ${more.length === 1 ? "area" : "areas"}</summary>${chips(more)}</details>`}${address}${!hasHours && emergency}</div>`;
  const hours =
    hasHours &&
    html`<div class="area-col hours-col">${itemHeading(level, "h3", html`${icon("clock")}Hours`)}<dl class="hours">${groupedHours(facts.hours).map((r) => (r.value === "Closed" ? html`<div class="hrow closed"><dt>${r.label}</dt><dd>${r.value}</dd></div>` : html`<div class="hrow"><dt>${r.label}</dt><dd>${r.value}</dd></div>`))}</dl>${emergency}</div>`;
  const label = hasHours ? "Service area & hours" : "Service area";

  return band(
    ctx,
    "serviceArea",
    { eyebrow: label, title: "Where we work", pageTitle: label, intro: serviceArea.note },
    hasHours ? "wrap" : "wrap area-wrap--one",
    html`<div class="${hasHours ? "area card" : "area area--one card"}">${places}${hours}</div>`,
  );
}
