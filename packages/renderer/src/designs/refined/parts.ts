// Small pieces every Classic section shares. Owner text is always escaped by the html template; only
// literal markup from this file is marked as trusted.
import type { Facts, OpeningHours, SiteDocument, Trade } from "@asksite/site-schema";
import type { RenderContext } from "../../context.ts";
import { formatPhone, telUrl, weeklyHours } from "../../format.ts";
import { fragment, html, trusted, type SafeHtml, type Value } from "../../html.ts";
import { icon as sharedIcon, type IconName } from "../../icons.ts";
import { DOM_ID } from "../../sections/ids.ts";

// Tabler Icons 3.x (MIT, see NOTICES.md): the Classic icons the shared set lacks, bodies copied
// from @iconify-json/tabler (receipt-2, calendar, building-store, mail, plus, arrow-up-right).
const BODIES = {
  receipt: trusted('<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-3-2l-2 2l-2-2l-2 2l-2-2z"/><path d="M14 8h-2.5a1.5 1.5 0 0 0 0 3h1a1.5 1.5 0 0 1 0 3H10m2 0v1.5m0-9V8"/></g>'),
  calendar: trusted('<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zm12-4v4M8 3v4m-4 4h16m-9 4h1m0 0v3"/>'),
  store: trusted('<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 21h18M3 7v1a3 3 0 0 0 6 0V7m0 1a3 3 0 0 0 6 0V7m0 1a3 3 0 0 0 6 0V7H3l2-4h14l2 4M5 21V10.85M19 21V10.85M9 21v-4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v4"/>'),
  mail: trusted('<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m3 7l9 6l9-6"/></g>'),
  plus: trusted('<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v14m-7-7h14"/>'),
  arrow: trusted('<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 7L7 17M8 7h9v9"/>'),
} as const;

export type ClassicIcon = IconName | keyof typeof BODIES;

/** A decorative 24x24 icon; `cls` is a whole class string from this folder. */
export function icon(name: ClassicIcon, cls = "i"): SafeHtml {
  return name in BODIES
    ? html`<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${BODIES[name as keyof typeof BODIES]}</svg>`
    : sharedIcon(name as IconName, cls);
}

/**
 * A line of short facts joined by a centred dot. Each dot is its item's ::before, in a column the row
 * pushes out past its clip box, so no line starts or ends with a dot. An item marked `phone` shows on
 * phones only (the founded year, which the seal shows from 48rem).
 */
export function dots(items: ReadonlyArray<{ text: Value; phone?: boolean }>): SafeHtml {
  const item = ({ text, phone }: { text: Value; phone?: boolean }) =>
    phone === true ? html`<span class="eb-y"><span>${text}</span></span>` : html`<span><span>${text}</span></span>`;
  return html`<span class="dots"><span class="dots-r">${items.map((each, i) => html`${i > 0 ? " " : ""}${item(each)}`)}</span></span>`;
}

/** A review's name and town. */
export const reviewer = (review: Facts["testimonials"][number]): SafeHtml =>
  html`<span class="qn">${review.name}</span>${review.location !== undefined && html`<span class="qp">${review.location}</span>`}`;

/** The business card and the Contact band name at most this many towns before "and N more". */
const TOWNS_SHOWN = 3;

/** The towns in a sentence: at most three, then a link to the Service area section for the rest. */
export function townSummary(ctx: RenderContext): SafeHtml {
  const places = ctx.doc.facts.serviceArea.places;
  const shown = places.slice(0, TOWNS_SHOWN);
  const more = places.length - shown.length;
  if (more > 0) {
    return html`${shown.join(", ")} <span class="whitespace-nowrap">and ${more} more.</span> <a class="whitespace-nowrap" href="${fragment(DOM_ID.serviceArea)}">See all areas</a>`;
  }
  return html`${shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`}`;
}

/** A licence number that never splits while it fits on a line. */
export const lic = (number: string): SafeHtml => html`<span class="lic">${number}</span>`;

/** An email that may wrap only after "@" or before a ".", never inside a word. */
export function email(address: string): SafeHtml[] {
  return address.split(/(?<=@)|(?=\.)/).map((part, i) => (i === 0 ? html`${part}` : html`<wbr>${part}`));
}

/**
 * A Call button. With the owner's 24/7 fact it carries that fact as a small second line; the words
 * shown are the accessible name, so name and label always match. Every tel: link carries
 * whitespace-nowrap: a phone number never breaks across lines (html-validate tel-non-breaking).
 */
export function callButton(facts: Facts, cls: string, label: Value): SafeHtml {
  const note = facts.emergency247;
  return html`<a class="${note ? `${cls} bt-2l whitespace-nowrap` : `${cls} whitespace-nowrap`}" href="${telUrl(facts.phone)}">${icon("phone")}<span class="bt-t"><span>${label}</span>${note && html`<span class="bt-n">24/7 emergency service</span>`}</span></a>`;
}

const isBooking = (text: string) => /^\s*(book|schedule)\b/i.test(text);

/** The owner's call to action as a button or heading label; a single bare word reads as a noun alone. */
export function ctaLong(doc: SiteDocument): string {
  const cta = doc.copy.ctaText.trim();
  if (/\s/.test(cta)) return cta;
  return isBooking(cta) ? "Book a visit" : "Get in touch";
}

/** The longest short label that fits the phone call bar at 320 px. */
const SHORT_MAX = 13;

/**
 * One short label for the header and the call bar: the owner's own when it fits; otherwise the free
 * offer, only with the owner's free-estimates fact; then a booking or quote label.
 */
export function ctaShort(doc: SiteDocument): string {
  const cta = ctaLong(doc);
  if (cta.length <= SHORT_MAX) return cta;
  const estimate = /\bestimates?\b/i.test(cta);
  const quote = /\bquotes?\b/i.test(cta) || /\bfree\b/i.test(cta);
  if (doc.facts.freeEstimates && (estimate || quote || !isBooking(cta))) return estimate ? "Free estimate" : "Free quote";
  if (isBooking(cta) && !estimate && !quote) return "Book now";
  return "Get a quote";
}

/** True when the owner's call to action books a visit rather than asks for a price. */
export const booksVisits = (doc: SiteDocument): boolean => isBooking(ctaLong(doc));

/** With 24/7 emergency service, the owner's hours are the regular hours (never "Closed" beside 24/7). */
export const hoursTitle = (facts: Facts): string => (facts.emergency247 ? "Regular hours" : "Hours");

/** Consecutive days with the same hours share one row: "Monday – Friday", "Saturday & Sunday". */
export function groupedHours(hours: readonly OpeningHours[]): Array<{ label: string; time: string }> {
  const rows: Array<{ from: string; to: string; span: number; time: string }> = [];
  for (const { day, time } of weeklyHours(hours)) {
    const last = rows.at(-1);
    if (last !== undefined && last.time === time) {
      last.to = day;
      last.span += 1;
    } else rows.push({ from: day, to: day, span: 1, time });
  }
  return rows.map(({ from, to, span, time }) => ({ label: span === 1 ? from : span === 2 ? `${from} & ${to}` : `${from} – ${to}`, time }));
}

/** The hours as rows, each one element, so its dotted rule runs unbroken across the row. */
export const hoursList = (hours: readonly OpeningHours[]): SafeHtml[] =>
  groupedHours(hours).map((row) => html`<div><dt>${row.label}</dt><dd>${row.time}</dd></div>`);

/** The trade in a sentence: "Ask us about any heating or cooling job." */
export const TRADE_WORD: Readonly<Record<Trade, string>> = {
  plumbing: "plumbing",
  hvac: "heating or cooling",
  electrical: "electrical",
  roofing: "roofing",
  cleaning: "cleaning",
  landscaping: "landscaping",
};

/** The mid-page Call-or-quote row (tablets and wider; phones have the call bar). */
export function ctaRow(doc: SiteDocument): SafeHtml {
  return html`<div class="cta-row">
${callButton(doc.facts, "bt bt-act bt-lg", `Call ${formatPhone(doc.facts.phone)}`)}
<span class="cta-or" aria-hidden="true">or</span>
<a class="bt bt-out bt-lg" href="${fragment("contact-form")}">${ctaLong(doc)}</a>
</div>`;
}

/** A section's heading: the accent rule, the h2 (id `${domId}-title`) and an optional intro. */
export function sectionHead(domId: string, title: Value, intro?: string): SafeHtml {
  return html`<div class="sh">
<h2 id="${domId}-title" class="st">${title}</h2>
${intro && html`<p>${intro}</p>`}
</div>`;
}
