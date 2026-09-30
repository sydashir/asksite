// Small pieces every Modern section shares: the section heading with its livery mark, the Call and quote
// buttons, the hours table and the credentials list. Every value goes through html``, which escapes it for
// where it lands; class strings are whole literals from this folder, so the sheet (styles/sheets/modern.css)
// defines each one.
import type { Facts, SectionId } from "@asksite/site-schema";
import { isVisible, type RenderContext } from "../../context.ts";
import { formatPhone, telUrl } from "../../format.ts";
import { fragment, html, type SafeHtml } from "../../html.ts";
import { icon } from "../../icons.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { CALENDAR } from "./icons.ts";
import { groupedHours } from "./text.ts";

/** Where a quote button leads: the contact heading and form (the contact section's inner column). */
export const FORM_ID = "contact-form";

/** An email address with a break chance before the @ and each dot, so a long one wraps only there. */
export function emailText(email: string): SafeHtml {
  return html`${email.split(/(?=[@.])/).map((part, i) => html`${i > 0 && html`<wbr>`}${part}`)}`;
}

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

/**
 * Text that wraps only between its parts, each part kept whole: "7:30 AM –" / "6:00 PM", "(512)" / "555-0142". So a
 * squeezed column (a narrow phone with WCAG 1.4.12 text spacing) wraps where a reader expects, never inside a time
 * or a number.
 */
export const keepParts = (parts: readonly string[]): SafeHtml =>
  html`${parts.map((part, i) => html`${i > 0 && " "}<span class="whitespace-nowrap">${part}</span>`)}`;

/** A time range in two parts after its dash; "Closed" and "Open 24 hours" as they are. */
const timeText = (time: string): SafeHtml | string => {
  const [opens, closes] = time.split(" – ");
  return closes === undefined || opens === undefined ? time : keepParts([`${opens} –`, closes]);
};

/** The weekly hours, consecutive days with the same time in one row. */
export function hoursTable(facts: Facts): SafeHtml {
  return html`<table class="hours"><tbody>
${groupedHours(facts.hours).map((row) => html`<tr><th scope="row">${row.days}</th><td class="time${row.time === "Closed" ? " closed" : ""}">${timeText(row.time)}</td></tr>`)}
</tbody></table>`;
}

/** The 24/7 note under the hours, with the phone as a link on its own line. Only for owners with 24/7 service. */
export function emergencyNote(facts: Facts): SafeHtml | false {
  return (
    facts.emergency247 &&
    html`<div class="em"><p><strong>Emergencies:</strong> available 24/7</p><a class="em-call whitespace-nowrap" href="${telUrl(facts.phone)}">${icon("phone", "i")}<span class="sr-only">Call </span>${formatPhone(facts.phone)}</a></div>`
  );
}

type Credential = {
  /** The icon (a whole literal: the shared icon() or ./icons.ts). */
  readonly mark: SafeHtml;
  /** The words, as plain text: their length decides whether the credential takes a whole row. */
  readonly text: string;
  /** The words as the page shows them, when that is more than plain text. */
  readonly shown?: SafeHtml;
  readonly note?: string | undefined;
  readonly wide?: boolean;
};

/** One credential: an icon, the fact in bold and, for a license, its label under it. */
export function credential(item: Credential): SafeHtml {
  return html`<li class="cred${item.wide === true ? " wide" : ""}">${item.mark}<span><strong>${item.shown ?? item.text}</strong>${item.note !== undefined && html`<small>${item.note}</small>`}</span></li>`;
}

/** A license number of up to this many characters stays in one piece; a longer one may break anywhere to fit. */
const WHOLE_NUMBER = 20;

/** "License M-40123", the number kept whole so it never splits at its hyphen (a longer number may break to fit). */
export const licenseText = (number: string): SafeHtml =>
  number.length <= WHOLE_NUMBER ? html`License <span class="whitespace-nowrap">${number}</span>` : html`License ${number}`;

/** A license as a credential: "License M-40123", with the owner's label under it. */
export const licenseItem = (licence: Facts["licences"][number], wide: boolean): Credential => ({
  mark: icon("certificate", "i"),
  text: `License ${licence.number}`,
  shown: licenseText(licence.number),
  note: licence.label,
  wide,
});

/** The insured fact as a credential. */
export const insuredItem = (): Credential => ({ mark: icon("shield-check", "i"), text: "Insured" });

/** 24/7 service as a credential. */
export const emergencyItem = (): Credential => ({ mark: icon("clock", "i"), text: "24/7 emergency service" });

/** The founding year and free estimates, each exactly as given. */
export function businessCredentials(facts: Facts): Credential[] {
  const items: Credential[] = [];
  if (facts.yearFounded !== undefined) items.push({ mark: CALENDAR, text: `Since ${facts.yearFounded}` });
  if (facts.freeEstimates) items.push({ mark: icon("circle-check", "i"), text: "Free estimates" });
  return items;
}

/** The owner's other trust facts, each exactly as given: insured, the founding year and free estimates. */
export const otherCredentials = (facts: Facts): Credential[] => [...(facts.insured ? [insuredItem()] : []), ...businessCredentials(facts)];
