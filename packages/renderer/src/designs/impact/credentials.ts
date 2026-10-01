// The Bold credentials band, drawn when the section is not straight under the hero (there the hero draws it
// as its card). Owner facts only: licences exactly as entered, Insured, the founding year and 24/7 service.
import type { RenderContext } from "../../context.ts";
import { html, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { icon } from "./icons.ts";
import { bandClass, licenceMarkup } from "./parts.ts";

/** The owner's credentials as spec items (a <dl>'s groups); the founding year only when `year` (About shows it as its numeral). */
export function credentialSpecs(ctx: RenderContext, year = true): SafeHtml[] {
  const { facts } = ctx.doc;
  const specs: SafeHtml[] = [];
  if (facts.licences.length > 0) {
    specs.push(html`<div class="spec spec-lic"><dt>${icon("certificate")}<span class="kicker">${facts.licences.length > 1 ? "Licenses" : "License"}</span></dt>${facts.licences.map((l) => html`<dd>${licenceMarkup(l)}</dd>`)}</div>`);
  }
  if (facts.insured) specs.push(html`<div class="spec"><dt>${icon("shield-check")}<span class="kicker">Insurance</span></dt><dd>Insured</dd></div>`);
  if (year && facts.yearFounded !== undefined) specs.push(html`<div class="spec"><dt>${icon("calendar")}<span class="kicker">In business</span></dt><dd>Since ${facts.yearFounded}</dd></div>`);
  if (facts.emergency247) specs.push(html`<div class="spec"><dt>${icon("clock")}<span class="kicker">Availability</span></dt><dd>24/7 emergency service</dd></div>`);
  return specs;
}

export function renderCredentials(ctx: RenderContext): SafeHtml {
  return html`<section id="${DOM_ID.trust}" class="${bandClass(ctx, "trust")} sec--rail" aria-label="Credentials">
<div class="wrap"><dl class="specs">${credentialSpecs(ctx)}</dl></div>
</section>`;
}
