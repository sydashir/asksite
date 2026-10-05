// Modern's hero and the owner's credentials.
// - With a photo: the photo as a band across the top on phones and tablets; from 1024 px (and on landscape
//   phones) the split hero, the text column beside the photo, so the headline and both buttons sit in the
//   upper part of the first screen on every desktop window.
// - Without one: the brand band with the 24/7 line, then the headline beside a card: the opening hours, or,
//   for an owner without them, where the business works and its email.
// - The credentials (the trust section) sit inside the hero, under the headline, when the trust section comes
//   straight after it; on phones they come after the Call button and before the subheadline, so they share the
//   first screen with the call bar. Anywhere else in the layout they are a band of their own on the brand colour,
//   and the hero keeps one short line with the licenses and insurance.
import type { Facts, VariantOf } from "@asksite/site-schema";
import { onPage, onSite, type RenderContext } from "../../context.ts";
import { mailtoUrl } from "../../format.ts";
import { html, safeUrl, type SafeHtml } from "../../html.ts";
import { icon } from "../../icons.ts";
import { DOM_ID } from "../../sections/ids.ts";
import {
  allLicensesLink,
  brandLine,
  businessCredentials,
  callButton,
  credential,
  credentialLine,
  emailText,
  emergencyItem,
  emergencyNote,
  head,
  hoursTable,
  insuredItem,
  licenseItem,
  otherCredentials,
  quoteButton,
  SHOWN_LICENSES,
} from "./parts.ts";
import { areaSummary, tradeAndCity } from "./text.ts";

/** True when the trust section comes straight after the hero on Home (the owner's order, A16 U1), so the hero holds it. */
export const trustInHero = (ctx: RenderContext): boolean => ctx.page.sections[1]?.id === "trust";

/** The 24/7 fact and the trade and city (unless the headline names the city), as one line; nothing when there is neither. */
const heroLine = (ctx: RenderContext, className: string): SafeHtml | false => brandLine(ctx.doc.facts, tradeAndCity(ctx.doc.facts, ctx.doc.copy.heroHeadline), className);

/** Two licenses in the hero, a license number too long for one line, or more licenses than the hero shows. */
const isDense = (facts: Facts): boolean =>
  facts.licences.length > 1 || facts.licences.some((licence) => `License ${licence.number}`.length > LONG_CREDENTIAL);

/** A credential longer than this takes a whole row on phones. */
const LONG_CREDENTIAL = 16;

/** The credentials inside the hero: at most two licenses, then insured, founded and free estimates (24/7 when that is all). */
function heroCredentials(facts: Facts): SafeHtml {
  const shown = facts.licences.slice(0, SHOWN_LICENSES);
  const more = facts.licences.length > shown.length;
  // Two licenses, a long one, or a "see all" link take whole rows, so the licenses always sit together, first.
  const wideLicense = (text: string) => shown.length > 1 || more || text.length > LONG_CREDENTIAL;
  const items = [...shown.map((licence) => licenseItem(licence, wideLicense(`License ${licence.number}`))), ...otherCredentials(facts)];
  // The 24/7 line above the headline says it too, but a trust section never shows an empty list.
  if (items.length === 0) items.push(emergencyItem());
  return html`<section id="${DOM_ID.trust}" class="proof" aria-label="Credentials">
<ul class="proof-list">${items.map((item) => credential({ ...item, wide: item.wide === true || item.text.length > LONG_CREDENTIAL }))}${allLicensesLink(facts)}</ul>
</section>`;
}

/**
 * The trust section as a band of its own on the brand colour, when the layout puts it anywhere but straight after the
 * hero. Three groups, each a list: the licenses, insurance, then the founding year, free estimates and 24/7 service.
 * From 768 px the groups flow in rows at their own widths with one gap (styles/sheets/modern.css), and a group that
 * does not fit moves to the next row whole: a credential never wraps where it fits, and "Insured" joins whichever
 * row has room for it.
 */
export function renderTrustBand(facts: Facts): SafeHtml {
  const groups = [
    facts.licences.map((licence) => licenseItem(licence, false)),
    facts.insured ? [insuredItem()] : [],
    [...businessCredentials(facts), ...(facts.emergency247 ? [emergencyItem()] : [])],
  ].filter((group) => group.length > 0);
  return html`<section id="${DOM_ID.trust}" class="trust on-brand" aria-labelledby="${DOM_ID.trust}-title">
<div class="wrap">
${head(DOM_ID.trust, "Credentials")}
<div class="creds">${groups.map((group) => html`<ul>${group.map(credential)}</ul>`)}</div>
</div>
</section>`;
}

/**
 * When the trust section comes later in the layout, the hero still names the licenses (two at most) and insurance
 * in one short line, so the first screen carries them; the band lists everything. Nothing when the owner hid the
 * trust section or has neither fact.
 */
function proofLine(ctx: RenderContext): SafeHtml | false {
  const { facts } = ctx.doc;
  const items = [...facts.licences.slice(0, SHOWN_LICENSES).map((licence) => licenseItem(licence, false)), ...(facts.insured ? [insuredItem()] : [])];
  return onPage(ctx, "trust") && !trustInHero(ctx) && credentialLine(items);
}

/**
 * The headline, subheadline and the Call and quote buttons. On phones Call, which shows the number, comes straight
 * under the headline, high enough that the sticky call bar never covers part of it on any phone screen, and the quote
 * button is left to the call bar (judges, A16 round 3; moderator ruling: the call bar keeps "Call" and "Get a quote",
 * and the hero's Call shows the number on the first screen).
 */
function panel(ctx: RenderContext, line: SafeHtml | false): SafeHtml {
  const { facts, copy } = ctx.doc;
  return html`<div class="panel">
${line}
<h1 id="${DOM_ID.hero}-title" class="display h1${copy.heroHeadline.length > 60 ? " h1--long" : ""}">${copy.heroHeadline}</h1>
<p class="hero-sub">${copy.heroSubheadline}</p>
<div class="hero-actions">${callButton(facts, "button-lg")}${quoteButton(ctx, "button-lg")}</div>
${proofLine(ctx)}
</div>`;
}

/**
 * The no-photo hero's card. With opening hours (and the service area section on the page): the hours and the 24/7
 * note, so the first screen says when the business is open. Without them: where the business works (unless the
 * owner hid the service area) and its email, so the fewest-facts page still has a composed first screen. That card
 * balances the split hero, so it shows from 1024 px only (door--reach): on a phone or tablet it would repeat the
 * town under the subheadline and push the services down; the page says both again further down.
 */
function heroCard(ctx: RenderContext): SafeHtml {
  const { facts } = ctx.doc;
  if (showsHoursInHero(ctx)) {
    return html`<div class="door">
<p class="door-label">${facts.emergency247 ? "Office hours" : "Hours"}</p>
${hoursTable(facts)}
${emergencyNote(facts)}
</div>`;
  }
  return html`<div class="door door--reach"><dl class="reach">${onSite(ctx, "serviceArea") && html`<dt>Service area</dt><dd>${icon("map-pin", "i")}${areaSummary(facts)}</dd>`}<dt>Email</dt><dd><a href="${mailtoUrl(facts.email)}">${emailText(facts.email)}</a></dd></dl></div>`;
}

/**
 * Without a hero photo the hero's card shows the hours, so Home's first screen says when the business is open (the
 * Contact page's service area section shows them too). Only when the site shows that section: an owner who hides it
 * hides the hours too, as on every design.
 */
export const showsHoursInHero = (ctx: RenderContext): boolean =>
  ctx.doc.facts.heroPhoto === undefined && ctx.doc.facts.hours.length > 0 && onSite(ctx, "serviceArea");

export function renderHero(ctx: RenderContext, variant: VariantOf<"hero">): SafeHtml {
  const { facts } = ctx.doc;
  const photo = variant === "photo" ? facts.heroPhoto : undefined;
  const credentials = trustInHero(ctx) && heroCredentials(facts);

  if (photo === undefined) {
    const line = heroLine(ctx, "band-line");
    return html`<section id="${DOM_ID.hero}" class="hero hero--plain" aria-labelledby="${DOM_ID.hero}-title">
<div class="band band--brand">${line && html`<div class="wrap band-in">${line}</div>`}</div>
<div class="wrap hero-body">
${panel(ctx, false)}
${credentials}
${heroCard(ctx)}
</div>
</section>`;
  }

  // A square or portrait photo is cropped closer to its top, where a face sits. Dense credentials (two licenses, a
  // long license number or a "see all" link) take a shorter photo strip on short phones, so they clear the call bar.
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
