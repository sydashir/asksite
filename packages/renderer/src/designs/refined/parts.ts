// Small pieces every Classic section shares. Owner text is always escaped by the html template; only
// literal markup from this file is marked as trusted.
import type { Facts, OpeningHours, SectionId, SiteDocument, Trade } from "@asksite/site-schema";
import { headingLevel, sectionLink, type RenderContext } from "../../context.ts";
import { TRADE_LABEL, formatPhone, telUrl, weeklyHours } from "../../format.ts";
import { html, trusted, type SafeHtml, type Value } from "../../html.ts";
import { icon as sharedIcon, type IconName } from "../../icons.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { plan } from "./plan.ts";

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
 * pushes out past its clip box, so no line starts or ends with a dot. An item's `cls` (a whole class from this
 * folder) may show it at some widths only: the eyebrow's year (eyebrow()). An item may be a dots() line itself, a
 * group that wraps as one (the eyebrow's town and year).
 */
export function dots(items: ReadonlyArray<{ text: Value; cls?: string }>): SafeHtml {
  const item = ({ text, cls }: { text: Value; cls?: string }) => (cls ? html`<span class="${cls}"><span>${text}</span></span>` : html`<span><span>${text}</span></span>`);
  return html`<span class="dots"><span class="dots-r">${items.map((each, i) => html`${i > 0 ? " " : ""}${item(each)}`)}</span></span>`;
}

/** A review's name and town. */
export const reviewer = (review: Facts["testimonials"][number]): SafeHtml =>
  html`<span class="qn">${review.name}</span>${review.location !== undefined && html`<span class="qp">${review.location}</span>`}`;

/** The business card and the Contact band name at most this many towns before "and N more". */
const TOWNS_SHOWN = 3;

/** The towns in a sentence: at most three, then a link to the Service area section (on its page) for the rest. */
export function townSummary(ctx: RenderContext): SafeHtml {
  const places = ctx.doc.facts.serviceArea.places;
  const shown = places.slice(0, TOWNS_SHOWN);
  const more = places.length - shown.length;
  if (more > 0) {
    return html`${shown.join(", ")} <span class="whitespace-nowrap">and ${more} more.</span> <a class="whitespace-nowrap" href="${sectionLink(ctx, "serviceArea")}">See all areas</a>`;
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
 * A phone number as its parts, "(512)" and "555-0142", each of which never breaks. Where the sheet lets a tel: link wrap
 * (the big number and the Service area's Call button, with bigger default text on a phone; moderator 2026-10-05) the
 * only break is the space between them, in every engine. The text is the number exactly as formatPhone writes it.
 */
export const phoneParts = (e164: string): SafeHtml[] =>
  formatPhone(e164)
    .split(" ")
    .map((part, i) => html`${i > 0 && " "}<span class="whitespace-nowrap">${part}</span>`);

/**
 * A Call button. With the owner's 24/7 fact it carries that fact as a small second line; the words
 * shown are the accessible name, so name and label always match. Every tel: link carries
 * whitespace-nowrap: a phone number never breaks across lines (html-validate tel-non-breaking), except where
 * the sheet lets it wrap between the parts of phoneParts().
 */
export function callButton(facts: Facts, cls: string, label: Value): SafeHtml {
  const note = facts.emergency247;
  return html`<a class="${note ? `${cls} bt-2l whitespace-nowrap` : `${cls} whitespace-nowrap`}" href="${telUrl(facts.phone)}">${icon("phone")}<span class="bt-t"><span>${label}</span>${note && html`<span class="bt-n">24/7 emergency service</span>`}</span></a>`;
}

/** The line under a contact heading (the contact band, the closing band): the owner's own, or plain house words that claim nothing. */
export const contactLine = (doc: SiteDocument): string => doc.copy.sectionIntros.contact ?? "Tell us what you need, or give us a call.";

/**
 * True when the owner's call to action books a visit rather than asks for a price. Every quote button carries that
 * call to action word for word (copy.ctaText; WCAG 3.2.4, moderator ruling 2026-10-02): only the call bar's is fixed.
 */
export const booksVisits = (doc: SiteDocument): boolean => /^\s*(book|schedule)\b/i.test(doc.copy.ctaText);

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

/** More open rows than this make the hours too long for one line: the Service area section lists them. */
const SHORT_HOURS_ROWS = 2;

/**
 * The open hours in one line of dots ("Monday – Friday 7:30 AM – 6:00 PM · Saturday 8:00 AM – 2:00 PM"), for the
 * closing band and the contact band; false with no hours or more than two open rows.
 */
export function shortHours(facts: Facts): SafeHtml | false {
  const open = groupedHours(facts.hours).filter((row) => row.time !== "Closed");
  return open.length > 0 && open.length <= SHORT_HOURS_ROWS && dots(open.map((row) => ({ text: `${row.label} ${row.time}` })));
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

/** Who a visitor is looking for, in a question: "Need a plumber in Austin?" (the closing band's lead). */
const TRADE_PERSON: Readonly<Record<Trade, string>> = {
  plumbing: "a plumber",
  hvac: "heating or cooling help",
  electrical: "an electrician",
  roofing: "a roofer",
  cleaning: "a cleaner",
  landscaping: "a landscaper",
};

export const needLine = (facts: Facts): string => `Need ${TRADE_PERSON[facts.trade]} in ${facts.location.city}?`;

/**
 * How many characters of the town and the year, "Austin, TX · Since 1998", fit one phone row in the widest lettering
 * (Sturdy: about 10 px a character after the rule and the gutters, measured in Chromium and WebKit) below 24, 30, 40
 * and 48rem. Up to 24 fit every phone.
 */
const GROUP_TIERS: readonly number[] = [24, 30, 40, 56];

/**
 * The trade, the town and, with the owner's year, "Since 1998", joined by dots: the eyebrow of the hero and of every
 * inner page. The town and the year are one group, so where the whole line does not fit the trade takes the first line
 * and the town and year wrap together onto the second: the browser breaks it only where it really overflows, in every
 * lettering. A town so long that the group itself cannot fit one row leaves the year out below the width where it
 * does ("eb-gN"), so the year is never alone on a line. `year` places the year: "always"; "phones" leaves it to a seal
 * from 48rem (Home's hero); "none" to a seal at every width (About's, on the owner's photo or on the letter).
 */
export function eyebrow(facts: Facts, year: "always" | "phones" | "none"): SafeHtml {
  if (facts.yearFounded === undefined || year === "none") return tradeAndTown(facts);
  const place = `${facts.location.city}, ${facts.location.state}`;
  const text = `Since ${facts.yearFounded}`;
  const tier = GROUP_TIERS.findIndex((most) => `${place} · ${text}`.length <= most);
  const fits = tier === -1 ? "eb-g4" : tier > 0 ? `eb-g${tier}` : undefined;
  const cls = [year === "phones" ? "eb-y" : undefined, fits].filter(Boolean).join(" ");
  return dots([{ text: TRADE_LABEL[facts.trade] }, { text: dots([{ text: place }, cls ? { text, cls } : { text }]) }]);
}

/** The trade and the town joined by a dot, "Plumbing · Austin, TX": the eyebrow without a year, and the letter's sign-off. */
export const tradeAndTown = (facts: Facts): SafeHtml => dots([{ text: TRADE_LABEL[facts.trade] }, { text: `${facts.location.city}, ${facts.location.state}` }]);

/** A block's heading: the accent rule, the h2 (id `${domId}-title`) and an optional intro. */
export function sectionHead(domId: string, title: Value, intro?: string): SafeHtml {
  return html`<div class="sh">
<h2 id="${domId}-title" class="st">${title}</h2>
${intro && html`<p>${intro}</p>`}
</div>`;
}

/**
 * The opening of an inner page (A16), as Home's hero opens Home: the eyebrow, the page's one <h1> (with the id
 * `${domId}-title` when given), set larger, an optional intro and what follows it (a credential line, actions).
 */
export function pageHead(ctx: RenderContext, title: Value, options: { id?: string; intro?: string | undefined; after?: Value; year?: "always" | "none" } = {}): SafeHtml {
  const { id, intro, after, year = "always" } = options;
  return html`<div class="sh sh-pg">
<p class="eb">${eyebrow(ctx.doc.facts, year)}</p>
${id === undefined ? html`<h1 class="st">${title}</h1>` : html`<h1 id="${id}" class="st">${title}</h1>`}
${intro && html`<p>${intro}</p>`}
${after}
</div>`;
}

/**
 * A section's heading: the page's opening when the section opens an inner page (its title the page's <h1>), and
 * otherwise the accent rule and an h2. `after` follows the intro on the opening only.
 */
export function sectionTitle(ctx: RenderContext, id: SectionId, title: Value, intro?: string, after?: Value): SafeHtml {
  if (headingLevel(ctx, id) === 2) return sectionHead(DOM_ID[id], title, intro);
  return pageHead(ctx, title, { id: `${DOM_ID[id]}-title`, intro, after });
}

/**
 * The owner's proof in one line: the first license (its name and number), Insured and, when asked, Free estimates.
 * Only while the Credentials section renders on the site (an owner who hides it hides its facts, amendment A6).
 */
export function credentialLine(ctx: RenderContext, withFree: boolean): SafeHtml | false {
  const { facts } = ctx.doc;
  if (!plan(ctx).trustShown) return false;
  const first = facts.licences[0];
  const items: Array<{ text: Value }> = [
    ...(first ? [{ text: first.label }, { text: html`License ${lic(first.number)}` }] : []),
    ...(facts.insured ? [{ text: "Insured" }] : []),
    ...(withFree && facts.freeEstimates ? [{ text: "Free estimates" }] : []),
  ];
  return items.length > 0 && html`<p class="proof">${icon("shield-check")}${dots(items)}</p>`;
}

/** The founded year as a round seal: Classic's stamp on the hero's print or card, and on About. */
export const seal = (facts: Facts): SafeHtml | false =>
  facts.yearFounded !== undefined && html`<p class="seal"><span class="seal-l">Since</span> <span class="seal-y">${facts.yearFounded}</span></p>`;

/** An item heading inside section `id`: an h3 under its h2, an h2 under the page's h1, so no level is skipped. */
export function itemHeading(ctx: RenderContext, id: SectionId, cls: string, content: Value): SafeHtml {
  return headingLevel(ctx, id) === 1 ? html`<h2 class="${cls}">${content}</h2>` : html`<h3 class="${cls}">${content}</h3>`;
}
