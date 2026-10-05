// Small pieces every Modern section shares: the section heading with its livery mark, the Call and quote
// buttons, the hours table and the credentials list. Every value goes through html``, which escapes it for
// where it lands; class strings are whole literals from this folder, so the sheet (styles/sheets/modern.css)
// defines each one.
import type { Facts, SectionId } from "@asksite/site-schema";
import { headingLevel, onSite, quoteLink, type RenderContext } from "../../context.ts";
import { formatPhone, formatPrice, telUrl } from "../../format.ts";
import { fragment, html, type SafeHtml } from "../../html.ts";
import { icon } from "../../icons.ts";
import { ARROW_DOWN, CALENDAR } from "./icons.ts";
import { areaSummary, groupedHours, tradeAndCity } from "./text.ts";

/** Where the full list of licenses is: the footer's credentials (every license, exactly as entered). */
export const LICENSES_ID = "licenses";

/** Licenses a list of credentials shows; the rest are one link away (the footer lists them all). */
export const SHOWN_LICENSES = 2;

/** An email address with a break chance before the @ and each dot, so a long one wraps only there. */
export function emailText(email: string): SafeHtml {
  return html`${email.split(/(?=[@.])/).map((part, i) => html`${i > 0 && html`<wbr>`}${part}`)}`;
}

/**
 * A block's heading: the livery mark, the heading (labels the block, whose element id is `domId`), an optional intro
 * and an optional `extra` under it (the owner's credentials, or the buttons). `level` 1 is an inner page's one <h1>,
 * in its first section (A16, headingLevel); otherwise an h2. Two literal branches, because a template cannot
 * interpolate a tag name.
 */
export function head(domId: string, title: string, intro?: string, level: 1 | 2 = 2, extra: SafeHtml | false = false): SafeHtml {
  const heading =
    level === 1 ? html`<h1 id="${domId}-title" class="display h1">${title}</h1>` : html`<h2 id="${domId}-title" class="display h2">${title}</h2>`;
  return html`<div class="head">
${heading}
${intro && html`<p class="lede">${intro}</p>`}
${extra}
</div>`;
}

/** The 24/7 fact and `tag` (the trade and the town) as one line of flat text; nothing when there is neither. */
export function brandLine(facts: Facts, tag: string | undefined, className: string): SafeHtml | false {
  return (
    (facts.emergency247 || tag !== undefined) &&
    html`<p class="${className}">${facts.emergency247 && html`<span class="line-247">${icon("clock", "i")}24/7 emergency service</span>`}${tag !== undefined && html`<span class="line-tag">${tag}</span>`}</p>`
  );
}

/**
 * An inner page's opening (A16, moderator ruling (e)): Home's brand strip, with the 24/7 fact and the trade and the
 * town, and its livery seam, at the top of the page's first section, above its h1. Nothing on Home or in a later
 * section.
 */
export function pageBand(ctx: RenderContext, id: SectionId): SafeHtml | false {
  return headingLevel(ctx, id) === 1 && html`<div class="band band--brand"><div class="wrap band-in">${brandLine(ctx.doc.facts, tradeAndCity(ctx.doc.facts, ""), "band-line")}</div></div>`;
}

/** The Call button. `className` adds a whole literal class string (size or place). */
export function callButton(facts: Facts, className: string): SafeHtml {
  return html`<a class="button button-act whitespace-nowrap ${className}" href="${telUrl(facts.phone)}">${icon("phone", "i")}Call ${formatPhone(facts.phone)}</a>`;
}

/** "From $89" as a pill under a service's name; nothing for a service without a price (none is ever invented). */
export const fromPrice = (dollars: number | undefined): SafeHtml | false =>
  dollars !== undefined && html`<p class="price"><small>From</small> ${formatPrice(dollars)}</p>`;

/** A service's price line: its "From" pill, or "Price on request" while another of the owner's services has a price. */
export const priceLine = (facts: Facts, dollars: number | undefined): SafeHtml | false =>
  fromPrice(dollars) || (facts.services.some((s) => s.startingPrice !== undefined) && html`<p class="price price--ask">Price on request</p>`);

/** The owner's call to action, leading to the quote form on the Contact page, which every site has (A16). */
export function quoteButton(ctx: RenderContext, className: string): SafeHtml {
  return html`<a class="button button-line ${className}" href="${quoteLink()}">${ctx.doc.copy.ctaText}</a>`;
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

/** Free estimates as a credential. */
export const freeEstimatesItem = (): Credential => ({ mark: icon("circle-check", "i"), text: "Free estimates" });

/** The towns the business serves, summed up as in the no-photo hero: "Serving Austin, Round Rock and 5 more". */
export const areaItem = (facts: Facts): Credential => ({ mark: icon("map-pin", "i"), text: `Serving ${areaSummary(facts)}` });

/** The founding year and free estimates, each exactly as given. */
export function businessCredentials(facts: Facts): Credential[] {
  const items: Credential[] = [];
  if (facts.yearFounded !== undefined) items.push({ mark: CALENDAR, text: `Since ${facts.yearFounded}` });
  if (facts.freeEstimates) items.push(freeEstimatesItem());
  return items;
}

/** The owner's other trust facts, each exactly as given: insured, the founding year and free estimates. */
export const otherCredentials = (facts: Facts): Credential[] => [...(facts.insured ? [insuredItem()] : []), ...businessCredentials(facts)];

/**
 * The owner's credentials on a page other than Home, each exactly as given: at most two licenses, insured, the
 * founding year and free estimates. Only while the site shows the trust section: an owner who hides it there hides
 * them on every page (the footer keeps the licenses, which several states require in all advertising).
 */
export const pageCredentials = (ctx: RenderContext): Credential[] =>
  onSite(ctx, "trust") ? [...ctx.doc.facts.licences.slice(0, SHOWN_LICENSES).map((licence) => licenseItem(licence, false)), ...otherCredentials(ctx.doc.facts)] : [];

/** "See all 5 licenses", a link down to the footer's full list, when the owner has more licenses than a list shows. */
export const allLicensesLink = (facts: Facts): SafeHtml | false =>
  facts.licences.length > SHOWN_LICENSES && html`<li class="more"><a href="${fragment(LICENSES_ID)}">See all ${facts.licences.length} licenses${ARROW_DOWN}</a></li>`;

/** Credentials as one short line of icons and words (the hero's line, under the Services heading, in the closing band). */
export const credentialLine = (items: readonly Credential[]): SafeHtml | false =>
  items.length > 0 && html`<ul class="proof-line">${items.map((item) => html`<li>${item.mark}<span>${item.shown ?? item.text}</span></li>`)}</ul>`;

/** Credentials as a list, each with its label under it, and the link to every license (About, Contact). */
export const credentialList = (ctx: RenderContext): SafeHtml | false => {
  const items = pageCredentials(ctx);
  return items.length > 0 && html`<ul class="facts">${items.map(credential)}${allLicensesLink(ctx.doc.facts)}</ul>`;
};
