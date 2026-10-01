// The Bold credentials band, drawn when the section is not straight under the hero (there the hero draws it as its
// card, and only there: each fact shows once). Owner facts only: licences exactly as entered, Insured, the founding
// year, and 24/7 service unless the hero's chip already says it. Several licences get a row of their own, so long
// numbers never squeeze into one column.
import type { RenderContext } from "../../context.ts";
import { html, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { icon } from "./icons.ts";
import { bandClass, licenceMarkup } from "./parts.ts";

/** Which of the owner's facts a spec list leaves out: the founding year (About shows it as its numeral), 24/7 service (Home's hero chip shows it). */
interface SpecOptions {
  readonly year: boolean;
  readonly availability: boolean;
}

/** The owner's credentials as spec items (a <dl>'s groups). */
export function credentialSpecs(ctx: RenderContext, { year, availability }: SpecOptions): SafeHtml[] {
  const { facts } = ctx.doc;
  const specs: SafeHtml[] = [];
  if (facts.licences.length > 0) {
    specs.push(html`<div class="spec spec-lic"><dt>${icon("certificate")}<span class="kicker">${facts.licences.length > 1 ? "Licenses" : "License"}</span></dt>${facts.licences.map((l) => html`<dd>${licenceMarkup(l)}</dd>`)}</div>`);
  }
  if (facts.insured) specs.push(html`<div class="spec"><dt>${icon("shield-check")}<span class="kicker">Insurance</span></dt><dd>Insured</dd></div>`);
  if (year && facts.yearFounded !== undefined) specs.push(html`<div class="spec"><dt>${icon("calendar")}<span class="kicker">In business</span></dt><dd>Since ${facts.yearFounded}</dd></div>`);
  if (availability && facts.emergency247) specs.push(html`<div class="spec"><dt>${icon("clock")}<span class="kicker">Availability</span></dt><dd>24/7 emergency service</dd></div>`);
  return specs;
}

export function renderCredentials(ctx: RenderContext): SafeHtml {
  // The hero's chip shows 24/7 service on Home; the band says it only when it is the owner's one credential.
  const others = credentialSpecs(ctx, { year: true, availability: false });
  const specs = others.length > 0 ? others : credentialSpecs(ctx, { year: true, availability: true });
  return html`<section id="${DOM_ID.trust}" class="${bandClass(ctx, "trust")} sec--rail" aria-label="Credentials">
<div class="wrap"><dl class="${ctx.doc.facts.licences.length > 1 ? "specs specs--lics" : "specs"}">${specs}</dl></div>
</section>`;
}
