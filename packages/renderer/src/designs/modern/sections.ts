// Modern's services, reviews, gallery and About. Every section opens with the same heading (the livery
// mark, the h2 and the intro); what follows is the design's own: services as priced cards, reviews led by one
// featured quote, the owner's photos in even rows with captions under them, and About as a statement on the
// brand band. The owner's photos each show once on the page: About never repeats one.
import type { VariantOf } from "@asksite/site-schema";
import { isVisible, type RenderContext } from "../../context.ts";
import { formatPrice } from "../../format.ts";
import { html, safeUrl, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { callButton, head, quoteButton } from "./parts.ts";

/**
 * How many columns `count` cards take on wide screens, at most `most`: the fewest rows, avoiding a last row with
 * one lone card, then the fewest empty places; ties go to more columns.
 */
export function balancedColumns(count: number, most: number): number {
  if (count <= 1) return 1;
  let best = 2;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let columns = 2; columns <= Math.min(most, count); columns++) {
    const rows = Math.ceil(count / columns);
    const last = count % columns || columns;
    const score = rows + (last === 1 ? 1.5 : 0) + 0.1 * (rows * columns - count) - 0.01 * columns;
    if (score < bestScore) [best, bestScore] = [columns, score];
  }
  return best;
}

const CARD_COLUMNS = { 1: "cards--c1", 2: "cards--c2", 3: "cards--c3", 4: "cards--c4" } as const;

export function renderServices(ctx: RenderContext, variant: VariantOf<"services">, tone: string): SafeHtml {
  const { facts, copy } = ctx.doc;
  const anyPrice = facts.services.some((s) => s.startingPrice !== undefined);
  // SiteDocument guarantees serviceDescriptions[i] names facts.services[i].
  const items = facts.services.map((service, i) => ({ ...service, description: copy.serviceDescriptions[i]?.description }));
  const columns = balancedColumns(items.length, variant === "compact" ? 4 : 3) as keyof typeof CARD_COLUMNS;
  const price = (dollars: number | undefined) =>
    dollars !== undefined
      ? html`<p class="price"><small>From</small> ${formatPrice(dollars)}</p>`
      : anyPrice && html`<p class="price price--ask">Price on request</p>`;
  const cta =
    isVisible(ctx, "contact") &&
    html`<div class="svc-cta"><p>${anyPrice ? "Not sure which service you need? Tell us about the job." : "Ask us for a price. Tell us what you need."}</p>${quoteButton(ctx, "")}</div>`;

  return html`<section id="${DOM_ID.services}" class="sec ${tone}" aria-labelledby="${DOM_ID.services}-title">
<div class="wrap svc">
${head("services", "Our services", copy.sectionIntros.services)}
<ul class="cards ${CARD_COLUMNS[columns]}${variant === "compact" ? " cards--compact" : ""}">
${items.map((s) => html`<li class="card"><div class="card-top"><h3 class="h3">${s.name}</h3>${price(s.startingPrice)}</div>${s.description && html`<p class="card-desc">${s.description}</p>`}</li>`)}
</ul>
${cta}
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
${head("testimonials", "What customers say")}
${lead && html`<figure class="lead-q${size}${rest.length === 0 ? " lead-q--solo" : ""}"><blockquote><p>${lead.quote}</p></blockquote>${who(lead)}</figure>`}
${rest.length > 0 && html`<ul class="quotes">${rest.map((t, i) => html`<li class="${spans[i] ?? "s6"}"><figure class="q"><blockquote><p>${t.quote}</p></blockquote>${who(t)}</figure></li>`)}</ul>`}
</div>
</section>`;
}

const SHOTS = { 1: "shots shots--one", 2: "shots shots--two", many: "shots" } as const;

export function renderGallery(ctx: RenderContext, _variant: VariantOf<"gallery">, tone: string): SafeHtml {
  const { facts, copy } = ctx.doc;
  const count = facts.photos.length;
  const shots = count === 1 ? SHOTS[1] : count === 2 || count === 4 ? SHOTS[2] : SHOTS.many;
  return html`<section id="${DOM_ID.gallery}" class="sec ${tone}" aria-labelledby="${DOM_ID.gallery}-title">
<div class="wrap">
${head("gallery", "Our work", copy.sectionIntros.gallery)}
<ul class="${shots}">
${facts.photos.map((p) => html`<li><figure><img src="${safeUrl(p.url, ["https:"])}" width="${p.width}" height="${p.height}" alt="${p.alt}" loading="lazy" decoding="async">${p.caption && html`<figcaption>${p.caption}</figcaption>`}</figure></li>`)}
</ul>
</div>
</section>`;
}

/**
 * The owner's statement set as type on the brand band, with the Call and quote buttons (beside it from
 * 1024 px). No photo: every owner photo already shows once, in the hero or the gallery.
 */
export function renderAbout(ctx: RenderContext, _variant: VariantOf<"about">): SafeHtml {
  const { facts, copy } = ctx.doc;
  const about = copy.about ?? "";
  const size = about.length > 300 ? " about-text--long" : about.length <= 140 ? " about-text--short" : "";
  return html`<section id="${DOM_ID.about}" class="sec on-brand" aria-labelledby="${DOM_ID.about}-title">
<div class="wrap about">
${head("about", "About us")}
<p class="about-text${size}">${about}</p>
<div class="about-foot">${callButton(facts, "")}${quoteButton(ctx, "")}</div>
</div>
</section>`;
}
