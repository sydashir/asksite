// Small pieces every Modern section shares: the section heading with its livery mark, the Call and quote
// buttons, the hours table and the credentials list. Every value goes through html``, which escapes it for
// where it lands; class strings are whole literals from this folder, so the sheet (styles/sheets/modern.css)
// defines each one.
import type { Facts, SectionId } from "@asksite/site-schema";
import { isVisible, type RenderContext } from "../../context.ts";
import { formatPhone, telUrl } from "../../format.ts";
import { fragment, html, type SafeHtml } from "../../html.ts";
import { icon, type IconName } from "../../icons.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { groupedHours } from "./text.ts";

/** Where a quote button leads: the contact heading and form (the contact section's inner column). */
export const FORM_ID = "contact-form";

/** A section's heading: the livery mark, the h2 (labels the section) and an optional intro. */
export function head(id: SectionId, title: string, intro?: string): SafeHtml {
  return html`<div class="head">
<h2 id="${DOM_ID[id]}-title" class="display h2">${title}</h2>
${intro && html`<p class="lede">${intro}</p>`}
</div>`;
}

/** The Call button. `className` adds a whole literal class string (size or place). */
export function callButton(facts: Facts, className: string): SafeHtml {
  return html`<a class="button button-act whitespace-nowrap ${className}" href="${telUrl(facts.phone)}">${icon("phone", "i")}Call ${formatPhone(facts.phone)}</a>`;
}

/** The owner's call to action, leading to the form; nothing when the page has no contact section. */
export function quoteButton(ctx: RenderContext, className: string): SafeHtml | false {
  return isVisible(ctx, "contact") && html`<a class="button button-line ${className}" href="${fragment(FORM_ID)}">${ctx.doc.copy.ctaText}</a>`;
}

/** The weekly hours, consecutive days with the same time in one row. */
export function hoursTable(facts: Facts): SafeHtml {
  return html`<table class="hours"><tbody>
${groupedHours(facts.hours).map((row) => html`<tr><th scope="row">${row.days}</th><td class="time${row.time === "Closed" ? " closed" : ""}">${row.time}</td></tr>`)}
</tbody></table>`;
}

/** The 24/7 note under the hours, with the phone as a link on its own line. Only for owners with 24/7 service. */
export function emergencyNote(facts: Facts): SafeHtml | false {
  return (
    facts.emergency247 &&
    html`<div class="em"><p><strong>Emergencies:</strong> available 24/7</p><a class="em-call whitespace-nowrap" href="${telUrl(facts.phone)}">${icon("phone", "i")}<span class="sr-only">Call </span>${formatPhone(facts.phone)}</a></div>`
  );
}

type Credential = { readonly icon: IconName; readonly text: string; readonly note?: string | undefined; readonly wide?: boolean };

/** One credential: an icon, the fact in bold and, for a license, its label under it. */
export function credential(item: Credential): SafeHtml {
  return html`<li class="cred${item.wide === true ? " wide" : ""}">${icon(item.icon, "i")}<span><strong>${item.text}</strong>${item.note !== undefined && html`<small>${item.note}</small>`}</span></li>`;
}

/** A license as a credential: "License M-40123", with the owner's label under it. */
export const licenseItem = (licence: Facts["licences"][number], wide: boolean): Credential => ({
  icon: "certificate",
  text: `License ${licence.number}`,
  note: licence.label,
  wide,
});

/** The owner's other trust facts, each exactly as given: insured, the founding year and free estimates. */
export function otherCredentials(facts: Facts): Credential[] {
  const items: Credential[] = [];
  if (facts.insured) items.push({ icon: "shield-check", text: "Insured" });
  if (facts.yearFounded !== undefined) items.push({ icon: "circle-check", text: `Since ${facts.yearFounded}` });
  if (facts.freeEstimates) items.push({ icon: "check", text: "Free estimates" });
  return items;
}
