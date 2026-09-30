// Modern's hero and the owner's credentials.
// - With a photo: the photo as a band across the top on phones and tablets; from 1024 px (and on landscape
//   phones) the split hero, the text column beside the photo, so the headline and both buttons sit in the
//   upper part of the first screen on every desktop window.
// - Without one: the brand band with the 24/7 line, then the headline beside a card with the opening hours.
// - The credentials (the trust section) sit inside the hero, under the headline, when the trust section comes
//   straight after it; on phones they come before the subheadline, so they share the first screen with the
//   call bar. Anywhere else in the layout they are a band of their own.
import type { Facts, VariantOf } from "@asksite/site-schema";
import { isVisible, type RenderContext } from "../../context.ts";
import { fragment, html, safeUrl, type SafeHtml } from "../../html.ts";
import { icon } from "../../icons.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { callButton, credential, emergencyNote, hoursTable, licenseItem, otherCredentials, quoteButton } from "./parts.ts";
import { tradeAndCity } from "./text.ts";

/** Where the full list of licenses is: the footer's credentials (every license, exactly as entered). */
export const LICENSES_ID = "licenses";

/** Licenses the hero shows; the rest are one link away (the footer lists them all). */
const HERO_LICENSES = 2;

/** True when the trust section comes straight after the hero, so the hero holds it. */
export const trustInHero = (ctx: RenderContext): boolean => ctx.sections[1]?.id === "trust";

/** The 24/7 fact and the trade and city, as one line of flat text; nothing when the owner has neither. */
function heroLine(ctx: RenderContext, className: string): SafeHtml | false {
  const { facts, copy } = ctx.doc;
  const tag = tradeAndCity(facts, copy.heroHeadline);
  return (
    (facts.emergency247 || tag !== undefined) &&
    html`<p class="${className}">${facts.emergency247 && html`<span class="line-247">${icon("clock", "i")}24/7 emergency service</span>`}${tag !== undefined && html`<span class="line-tag">${tag}</span>`}</p>`
  );
}

/** Two licenses in the hero, a license number too long for one line, or more licenses than the hero shows. */
const isDense = (facts: Facts): boolean =>
  facts.licences.length > 1 || facts.licences.some((licence) => `License ${licence.number}`.length > LONG_CREDENTIAL);

/** A credential longer than this takes a whole row on phones. */
const LONG_CREDENTIAL = 16;

/** The credentials inside the hero: at most two licenses, then insured, founded and free estimates. */
function heroCredentials(facts: Facts): SafeHtml {
  const shown = facts.licences.slice(0, HERO_LICENSES);
  const more = facts.licences.length - shown.length;
  // Two licenses, a long one, or a "more" link take whole rows, so the licenses always sit together, first.
  const wideLicense = (text: string) => shown.length > 1 || more > 0 || text.length > LONG_CREDENTIAL;
  const items = [...shown.map((licence) => licenseItem(licence, wideLicense(`License ${licence.number}`))), ...otherCredentials(facts)];
  return html`<section id="${DOM_ID.trust}" class="proof" aria-label="Credentials">
<ul class="proof-list">${items.map((item) => credential({ ...item, wide: item.wide === true || item.text.length > LONG_CREDENTIAL }))}${more > 0 && html`<li class="more"><a href="${fragment(LICENSES_ID)}">${more} more license${more > 1 ? "s" : ""}${icon("chevron-down", "i")}</a></li>`}</ul>
</section>`;
}

/** The trust section as a band of its own, when the layout puts it anywhere but straight after the hero. */
export function renderTrustBand(facts: Facts, tone: string): SafeHtml {
  const items = [
    ...facts.licences.map((licence) => licenseItem(licence, false)),
    ...otherCredentials(facts),
    ...(facts.emergency247 ? [{ icon: "clock" as const, text: "24/7 emergency service" }] : []),
  ];
  return html`<section id="${DOM_ID.trust}" class="trust ${tone}" aria-labelledby="${DOM_ID.trust}-title">
<div class="wrap">
<h2 id="${DOM_ID.trust}-title" class="trust-h">Credentials</h2>
<ul class="creds">${items.map(credential)}</ul>
</div>
</section>`;
}

/** The headline, subheadline and the Call and quote buttons (the buttons show from 768 px; phones have the call bar). */
function panel(ctx: RenderContext, line: SafeHtml | false): SafeHtml {
  const { facts, copy } = ctx.doc;
  return html`<div class="panel">
${line}
<h1 id="${DOM_ID.hero}-title" class="display h1${copy.heroHeadline.length > 60 ? " h1--long" : ""}">${copy.heroHeadline}</h1>
<p class="hero-sub">${copy.heroSubheadline}</p>
<div class="hero-actions">${callButton(facts, "button-lg")}${quoteButton(ctx, "button-lg")}</div>
</div>`;
}

/** The no-photo hero's card: the opening hours (and the 24/7 note), when the service area section would show them. */
function hoursCard(ctx: RenderContext): SafeHtml | false {
  const { facts } = ctx.doc;
  return (
    showsHoursInHero(ctx) &&
    html`<div class="door">
<p class="door-label">${facts.emergency247 ? "Office hours" : "Hours"}</p>
${hoursTable(facts)}
${emergencyNote(facts)}
</div>`
  );
}

/**
 * Without a hero photo the hours move up into the hero's card, so the first screen says when the business is
 * open; the service area section then shows the places only. Only when that section is on the page: an owner
 * who hides it hides the hours too, as on every design.
 */
export const showsHoursInHero = (ctx: RenderContext): boolean =>
  ctx.doc.facts.heroPhoto === undefined && ctx.doc.facts.hours.length > 0 && isVisible(ctx, "serviceArea");

export function renderHero(ctx: RenderContext, variant: VariantOf<"hero">): SafeHtml {
  const { facts } = ctx.doc;
  const photo = variant === "photo" ? facts.heroPhoto : undefined;
  const credentials = trustInHero(ctx) && heroCredentials(facts);

  if (photo === undefined) {
    const line = heroLine(ctx, "band-line");
    const card = hoursCard(ctx);
    return html`<section id="${DOM_ID.hero}" class="hero hero--plain${card === false ? "" : " hero--card"}" aria-labelledby="${DOM_ID.hero}-title">
<div class="band band--brand">${line && html`<div class="wrap band-in">${line}</div>`}</div>
<div class="wrap hero-body">
${panel(ctx, false)}
${credentials}
${card}
</div>
</section>`;
  }

  // A square or portrait photo is cropped closer to its top, where a face sits. Dense credentials (two licenses, a
  // long license number or a "more" link) take a shorter photo strip on short phones, so they clear the call bar.
  const tall = photo.width / photo.height < 1.2 ? " hero--tall" : "";
  const dense = credentials !== false && isDense(facts) ? " hero--dense" : "";
  return html`<section id="${DOM_ID.hero}" class="hero hero--photo${tall}${dense}" aria-labelledby="${DOM_ID.hero}-title">
<div class="band band--photo"><img src="${safeUrl(photo.url, ["https:"])}" width="${photo.width}" height="${photo.height}" alt="${photo.alt}" loading="eager" fetchpriority="high" decoding="async"></div>
<div class="wrap hero-body">
${panel(ctx, heroLine(ctx, "hl"))}
${credentials}
</div>
</section>`;
}
