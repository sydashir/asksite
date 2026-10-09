// Classic's hero: an eyebrow (trade, town, year), the headline, the Call and quote buttons (from 48rem: on phones the
// call bar under the thumb carries both, as on the approved Home), the owner's credentials, and beside them the owner's
// photo as a framed print or, with no photo, a business card (phone, hours, towns, email). A round seal stamps the
// founded year; one short review sits under the print or the buttons. No text ever sits on a photo.
import type { Facts } from "@asksite/site-schema";
import { quoteLink, type RenderContext } from "../../context.ts";
import { formatPhone, mailtoUrl, telUrl } from "../../format.ts";
import { html, safeUrl, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { callButton, dots, email, eyebrow, groupedHours, hoursTitle, icon, lic, reviewer, seal, servingLine, type ClassicIcon } from "./parts.ts";
import { plan } from "./plan.ts";

/** A headline longer than this gets the smaller hero size. */
const LONG_HEADLINE = 60;

/** One short review: the caption plate of the print, or under the buttons in the card hero. */
function heroQuote(ctx: RenderContext, plate: boolean): SafeHtml | false {
  const review = ctx.doc.facts.testimonials[plan(ctx).heroQuote];
  if (review === undefined) return false;
  return html`<figure class="${plate ? "hq plate" : "hq"}"><blockquote><p>${review.quote}</p></blockquote><figcaption>${reviewer(review)}</figcaption></figure>`;
}

/** The credential rows the hero shows when the credentials section comes straight after it (and About's letter). */
export function ledger(facts: Facts): SafeHtml {
  const items: Array<{ icon: ClassicIcon; main: string; sub?: SafeHtml }> = facts.licences.map((l) => ({
    icon: "certificate",
    main: l.label,
    sub: html`License ${lic(l.number)}`,
  }));
  if (facts.insured) items.push({ icon: "shield-check", main: "Insured" });
  if (facts.freeEstimates) items.push({ icon: "receipt", main: "Free estimates" });
  // Four facts make two rows of two, so Insured moves up beside the first license: a short window shows the first row.
  const insured = items.findIndex((item) => item.main === "Insured");
  if (items.length === 4 && insured > 1) items.splice(1, 0, ...items.splice(insured, 1));
  // Columns follow the count (lg-N), so no row ends with one fact alone; an odd count gives the first a whole row on phones.
  const columns = items.length === 1 ? "ledger lg-1" : items.length === 2 ? "ledger lg-2" : [4, 7, 8].includes(items.length) ? "ledger lg-4" : "ledger";
  const odd = items.length % 2 === 1;
  const row = (item: (typeof items)[number]) =>
    html`${icon(item.icon)}<span><span class="tm">${item.main}</span>${item.sub !== undefined && html`<span class="tsub">${item.sub}</span>`}</span>`;
  return html`<ul class="${columns}">
${items.map((item, i) => (i === 0 && odd ? html`<li class="ti-w">${row(item)}</li>` : html`<li>${row(item)}</li>`))}
</ul>`;
}

/** The first license and Insured in one line, when the credentials are not right after the hero. */
function proofLine(facts: Facts): SafeHtml | false {
  const first = facts.licences[0];
  const items = [...(first ? [{ text: html`License ${lic(first.number)}` }] : []), ...(facts.insured ? [{ text: "Insured" }] : [])];
  return items.length > 0 && html`<p class="proof">${icon("shield-check")}${dots(items)}</p>`;
}

/** The business card that stands in for a photo: built only from the phone, hours, towns and email. */
function businessCard(ctx: RenderContext): SafeHtml {
  const { facts } = ctx.doc;
  const { cardHours, areaShown } = plan(ctx);
  return html`<div class="${facts.yearFounded !== undefined ? "bc bc-sealed" : "bc"}">
<p class="bc-l">Call us</p>
<a class="bc-ph whitespace-nowrap" href="${telUrl(facts.phone)}">${icon("phone")}<span>${formatPhone(facts.phone)}</span></a>
${cardHours && html`<div class="bc-h">
<p class="bc-s">${hoursTitle(facts)}</p>
<dl>
${groupedHours(facts.hours).map((row) => html`<div><dt>${row.label}</dt><dd>${row.time}</dd></div>`)}
</dl>
</div>`}
<ul class="bc-m">
${areaShown && html`<li>${icon("map-pin")}<span>${servingLine(ctx)}</span></li>`}
<li class="bc-e">${icon("mail")}<a href="${mailtoUrl(facts.email)}">${email(facts.email)}</a></li>
</ul>
</div>`;
}

export function renderHero(ctx: RenderContext): SafeHtml {
  const { facts, copy } = ctx.doc;
  const { photo: hasPhoto, lift, liftSwap, trustShown } = plan(ctx);
  // On phones the eyebrow ends with the founded year; from 48rem the seal shows it.
  const photo = hasPhoto ? facts.heroPhoto : undefined;
  const quote = heroQuote(ctx, photo !== undefined);
  const media = photo
    ? html`<div class="hm"><div class="${quote ? "frame fq" : "frame"}"><img src="${safeUrl(photo.url, ["https:"])}" width="${photo.width}" height="${photo.height}" alt="${photo.alt}" loading="eager" fetchpriority="high" decoding="async">${quote}</div>${seal(facts)}</div>`
    : html`<div class="${facts.yearFounded !== undefined ? "hm hm-card hm-sealed" : "hm hm-card"}">${businessCard(ctx)}${seal(facts)}</div>`;
  const classes = ["hero", lift && "h-lift", liftSwap && "h-swap", !photo && "h-card"].filter(Boolean).join(" ");

  return html`<section id="${DOM_ID.hero}" class="${classes}" aria-labelledby="${DOM_ID.hero}-title">
<div class="wr h-grid">
<div class="h-copy">
<p class="eb">${eyebrow(facts, "phones")}</p>
<h1 id="${DOM_ID.hero}-title" class="${copy.heroHeadline.length > LONG_HEADLINE ? "ht ht-long" : "ht"}">${copy.heroHeadline}</h1>
<p class="hs">${copy.heroSubheadline}</p>
<div class="ha">
${callButton(facts, "bt bt-act bt-lg", `Call ${formatPhone(facts.phone)}`)}
<a class="bt bt-out bt-lg" href="${quoteLink()}">${copy.ctaText}</a>
</div>
${lift ? ledger(facts) : trustShown && proofLine(facts)}
${!photo && quote}
</div>
${media}
</div>
</section>`;
}
