// Modern's services, reviews, gallery and About. Every section opens with the same heading (the livery
// mark, the heading and the intro); what follows is the design's own: services as priced cards, reviews led by one
// featured quote, the owner's photos in even rows with captions under them, and About as a statement on the
// brand band beside a photo. No page shows one of the owner's photos twice.
import type { Photo, VariantOf } from "@asksite/site-schema";
import { headingLevel, onSite, quoteLink, type RenderContext } from "../../context.ts";
import { html, safeUrl, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { itemHeading } from "../../ui.ts";
import { credentialLine, credentialList, head, pageBand, pageCredentials, priceLine } from "./parts.ts";

/**
 * The column count for `count` service cards, at most `most`: the most columns, up to one more than the services.
 * The call-to-action card closes the grid and fills whatever the last row leaves (styles/sheets/modern.css spans
 * it), so no row has a hole. Every site has the Contact page and its quote form (A16), so the card always shows.
 */
export const cardColumns = (count: number, most: number): number => Math.min(most, count + 1);

// cardColumns gives 2 to 4 (a services section always has at least one service).
const CARD_COLUMNS = { 2: "cards--c2", 3: "cards--c3", 4: "cards--c4" } as const;

/**
 * True when service `i` of `count` shares the last row with the call-to-action card in rows of `columns`: the card
 * fills the places the last row leaves.
 */
const sharesCardRow = (i: number, count: number, columns: number): boolean => count % columns !== 0 && i >= count - (count % columns);

// A service card's classes: card--t2 when it shares the call-to-action card's row in the two columns below 1024 px,
// card--t3 when it does in the grid's own columns from there; such a card keeps its own height (judges, A16 round 1).
const CARD = ["card", "card card--t2", "card card--t3", "card card--t2 card--t3"] as const;

/**
 * Services as cards, each price on its own line under the service's name, and the owner's credentials under the
 * heading, beside the prices where a visitor checks who the business is. The owner's call to action closes the grid
 * as a brand card that fills its last row (judges' must-fix: no empty cell beside the last service).
 */
export function renderServices(ctx: RenderContext, variant: VariantOf<"services">, tone: string): SafeHtml {
  const { facts, copy } = ctx.doc;
  const level = headingLevel(ctx, "services");
  // SiteDocument guarantees serviceDescriptions[i] names facts.services[i].
  const items = facts.services.map((service, i) => ({ ...service, description: copy.serviceDescriptions[i]?.description }));
  const columns = cardColumns(items.length, variant === "compact" ? 4 : 3) as keyof typeof CARD_COLUMNS;
  const anyPrice = facts.services.some((s) => s.startingPrice !== undefined);
  const askCard = html`<li class="card ask on-brand"><div><p class="ask-q">${anyPrice ? "Not sure which service you need?" : "Ask us for a price."}</p><p>${anyPrice ? "Tell us about the job." : "Tell us what you need."}</p></div><a class="button button-act" href="${quoteLink()}">${copy.ctaText}</a></li>`;

  const cardClass = (i: number) => CARD[(sharesCardRow(i, items.length, 2) ? 1 : 0) + (sharesCardRow(i, items.length, columns) ? 2 : 0)];
  return html`<section id="${DOM_ID.services}" class="sec ${tone}" aria-labelledby="${DOM_ID.services}-title">
${pageBand(ctx, "services")}
<div class="wrap">
${head(DOM_ID.services, "Our services", copy.sectionIntros.services, level, credentialLine(pageCredentials(ctx)))}
<ul class="cards ${CARD_COLUMNS[columns]}${variant === "compact" ? " cards--compact" : ""}">
${items.map((s, i) => html`<li class="${cardClass(i)}">${itemHeading(level, "h3", s.name)}${priceLine(facts, s.startingPrice)}${s.description && html`<p class="card-desc">${s.description}</p>`}</li>`)}
${askCard}
</ul>
</div>
</section>`;
}

/** Grid spans that fill balanced rows of three, two or one: "s2" is a third of a row, "s3" half, "s6" all. */
function rowSpans(count: number): string[] {
  if (count === 0) return [];
  const rows = Math.ceil(count / 3);
  const base = Math.floor(count / rows);
  const extra = count % rows;
  const SPAN: Record<number, string> = { 3: "s2", 2: "s3", 1: "s6" };
  return Array.from({ length: rows }, (_, row) => (row < extra ? base + 1 : base)).flatMap((size) => Array<string>(size).fill(SPAN[size] ?? "s6"));
}

export function renderReviews(ctx: RenderContext, _variant: VariantOf<"testimonials">, tone: string): SafeHtml {
  const [lead, ...rest] = ctx.doc.facts.testimonials;
  const who = (t: { name: string; location?: string | undefined }) =>
    html`<figcaption class="who"><strong>${t.name}</strong>${t.location !== undefined && html`<span>${t.location}</span>`}</figcaption>`;
  const spans = rowSpans(rest.length);
  const size = lead === undefined ? "" : lead.quote.length > 180 ? " lead-q--long" : lead.quote.length <= 100 && rest.length > 0 ? " lead-q--short" : "";

  return html`<section id="${DOM_ID.testimonials}" class="sec ${tone}" aria-labelledby="${DOM_ID.testimonials}-title">
<div class="wrap">
${head(DOM_ID.testimonials, "What customers say", undefined, headingLevel(ctx, "testimonials"))}
${lead && html`<figure class="lead-q${size}${rest.length === 0 ? " lead-q--solo" : ""}"><blockquote><p>${lead.quote}</p></blockquote>${who(lead)}</figure>`}
${rest.length > 0 && html`<ul class="quotes">${rest.map((t, i) => html`<li class="${spans[i] ?? "s6"}"><figure class="q"><blockquote><p>${t.quote}</p></blockquote>${who(t)}</figure></li>`)}</ul>`}
</div>
</section>`;
}

// Phones show one photo to a row, at the screen's width (judges, A16 round 1). From 640 px: two photos side by side;
// four as two rows of two below 1024 px, and from there as one large photo beside three (the approved mockup's
// mosaic, judges' round 3), so four photos never take more height than six; one photo across the content width.
const SHOTS = { 1: "shots shots--one", 2: "shots shots--two", 4: "shots shots--two shots--four", many: "shots" } as const;

export function renderGallery(ctx: RenderContext, _variant: VariantOf<"gallery">, tone: string): SafeHtml {
  const { facts, copy } = ctx.doc;
  const count = facts.photos.length;
  const shots = count === 1 || count === 2 || count === 4 ? SHOTS[count] : SHOTS.many;
  return html`<section id="${DOM_ID.gallery}" class="sec ${tone}" aria-labelledby="${DOM_ID.gallery}-title">
${pageBand(ctx, "gallery")}
<div class="wrap">
${head(DOM_ID.gallery, "Our work", copy.sectionIntros.gallery, headingLevel(ctx, "gallery"))}
<ul class="${shots}">
${facts.photos.map((p) => html`<li><figure><img src="${safeUrl(p.url, ["https:"])}" width="${p.width}" height="${p.height}" alt="${p.alt}" loading="lazy" decoding="async">${p.caption && html`<figcaption>${p.caption}</figcaption>`}</figure></li>`)}
</ul>
</div>
</section>`;
}

/**
 * The photo About shows beside the owner's statement: the gallery's first photo when the site shows the gallery (one
 * Home does not show), otherwise the hero photo, otherwise none. About has a page of its own, so no page shows a photo
 * twice (moderator ruling (e), A16).
 */
const aboutPhoto = (ctx: RenderContext): Photo | undefined => (onSite(ctx, "gallery") ? ctx.doc.facts.photos[0] : undefined) ?? ctx.doc.facts.heroPhoto;

/**
 * The owner's statement set as type on the brand band, then the owner's credentials (who a homeowner lets into the
 * house), with a photo beside them from 1024 px (under them on phones); without a photo the credentials take its
 * place. The band ends its page, before the closing band with the Call and quote buttons, so it carries no buttons of
 * its own.
 */
export function renderAbout(ctx: RenderContext, _variant: VariantOf<"about">): SafeHtml {
  const { facts, copy } = ctx.doc;
  const about = copy.about ?? "";
  const size = about.length > 300 ? " about-text--long" : about.length <= 140 ? " about-text--short" : "";
  const photo = aboutPhoto(ctx);
  const credentials = credentialList(ctx);
  return html`<section id="${DOM_ID.about}" class="sec on-brand" aria-labelledby="${DOM_ID.about}-title">
${pageBand(ctx, "about")}
<div class="${photo !== undefined ? "wrap about--photo" : credentials ? "wrap about--facts" : "wrap"}">
${head(DOM_ID.about, `About ${facts.businessName}`, undefined, headingLevel(ctx, "about"))}
<p class="about-text${size}">${about}</p>
${credentials}
${photo !== undefined && html`<img class="about-img" src="${safeUrl(photo.url, ["https:"])}" width="${photo.width}" height="${photo.height}" alt="${photo.alt}" decoding="async">`}
</div>
</section>`;
}
