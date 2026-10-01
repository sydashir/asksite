// The Bold service area and hours: one white panel with the towns served and the address, and the hours
// beside them, at every width. Hours never break inside a time or a day range (no-break spaces, rules.ts). When
// the owner puts this section first on the Contact page its heading is the page's <h1> (A16).
import { headingLevel, type RenderContext } from "../../context.ts";
import { formatPhone, telUrl } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { itemHeading } from "../../ui.ts";
import { icon } from "./icons.ts";
import { band } from "./parts.ts";
import { groupedHours } from "./rules.ts";

export function renderServiceArea(ctx: RenderContext): SafeHtml {
  const { facts } = ctx.doc;
  const { location, serviceArea } = facts;
  const level = headingLevel(ctx, "serviceArea");
  const hasHours = facts.hours.length > 0;
  const cityLine = `${location.city}, ${location.state}${location.postalCode === undefined ? "" : ` ${location.postalCode}`}`;
  const address = location.streetAddress
    ? html`<address class="addr">${location.streetAddress}<br>${cityLine}</address>`
    : html`<p class="addr">Based in ${cityLine}</p>`;
  const emergency =
    facts.emergency247 &&
    html`<p class="em">${icon("phone")}<span>24/7 emergency calls:</span> <a class="whitespace-nowrap" href="${telUrl(facts.phone)}">${formatPhone(facts.phone)}</a></p>`;
  const places = html`<div class="area-col">${itemHeading(level, "h3", html`${icon("map-pin")}Areas we serve`)}<ul class="chips">${serviceArea.places.map((p) => html`<li>${p}</li>`)}</ul>${address}${!hasHours && emergency}</div>`;
  const hours =
    hasHours &&
    html`<div class="area-col hours-col">${itemHeading(level, "h3", html`${icon("clock")}Hours`)}<dl class="hours">${groupedHours(facts.hours).map((r) => (r.value === "Closed" ? html`<div class="hrow closed"><dt>${r.label}</dt><dd>${r.value}</dd></div>` : html`<div class="hrow"><dt>${r.label}</dt><dd>${r.value}</dd></div>`))}</dl>${emergency}</div>`;
  // As the page's <h1>, today's words for the page (they name what the visitor came for).
  const label = hasHours ? "Service area & hours" : "Service area";

  return band(
    ctx,
    "serviceArea",
    { eyebrow: label, title: "Where we work", pageTitle: label, intro: serviceArea.note },
    hasHours ? "wrap" : "wrap area-wrap--one",
    html`<div class="${hasHours ? "area card" : "area area--one card"}">${places}${hours}</div>`,
  );
}
