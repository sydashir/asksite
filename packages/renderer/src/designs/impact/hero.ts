// The Bold hero. Text never sits on a photo: it is on a solid ink panel. On phones the owner's photo is a
// band above the text; from 64rem it fills the right side behind a slanted seam, and the credentials card
// sits on it. Without a photo the right side holds a card of the facts a caller checks first (hours and the
// towns served); with nothing new for a card the hero is type only.
import type { VariantOf } from "@asksite/site-schema";
import { isVisible, type RenderContext } from "../../context.ts";
import { TRADE_LABEL } from "../../format.ts";
import { fragment, html, safeUrl, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { icon } from "./icons.ts";
import { boldPage, callButton, ctaButton, licenceMarkup } from "./parts.ts";
import { groupedHours, headlineClass } from "./rules.ts";

/** Owner facts only: the first licence (never cut) and a count of the rest, Insured, and the founding year. */
function proofItems(ctx: RenderContext): SafeHtml[] {
  const { facts } = ctx.doc;
  const { trustInHero } = boldPage(ctx);
  const [first, ...rest] = facts.licences;
  const items: SafeHtml[] = [];
  if (first !== undefined) {
    items.push(html`<li class="proof-lic">${icon("certificate")}<span>${licenceMarkup(first, "proof-label", "proof-num")}</span></li>`);
    if (rest.length > 0) {
      const more = `+${rest.length} more ${rest.length === 1 ? "license" : "licenses"}`;
      items.push(
        trustInHero
          ? html`<li class="proof-more-li"><details class="proof-more"><summary>${more}</summary><ul>${rest.map((l) => html`<li>${licenceMarkup(l)}</li>`)}</ul></details></li>`
          : html`<li class="proof-more-li"><a class="proof-more-link" href="${fragment(DOM_ID.trust)}">${more}</a></li>`,
      );
    }
  }
  if (facts.insured) items.push(html`<li>${icon("shield-check")}<span>Insured</span></li>`);
  if (facts.yearFounded !== undefined) items.push(html`<li>${icon("calendar")}<span>Since ${facts.yearFounded}</span></li>`);
  if (trustInHero && items.length === 0 && facts.emergency247) items.push(html`<li>${icon("clock")}<span>24/7 emergency service</span></li>`);
  return items;
}

/**
 * The credentials under the headline, shown while the credentials section is on the page. Straight under
 * the hero that section IS this card, so it keeps its id and label here.
 */
function proof(ctx: RenderContext, items: readonly SafeHtml[]): SafeHtml | false {
  if (!isVisible(ctx, "trust") || items.length === 0) return false;
  return boldPage(ctx).trustInHero
    ? html`<section id="${DOM_ID.trust}" class="proof" aria-label="Credentials"><ul class="proof-list">${items}</ul></section>`
    : html`<div class="proof"><ul class="proof-list">${items}</ul></div>`;
}

/** The towns served: the first three, then "and N more", a link to the service area. */
function placesSummary(ctx: RenderContext): SafeHtml {
  const { places } = ctx.doc.facts.serviceArea;
  const first = places.slice(0, 3).join(", ");
  const rest = places.length - 3;
  if (rest <= 0) return html`${first}`;
  return html`${first} <span class="whitespace-nowrap">and <a href="${fragment(DOM_ID.serviceArea)}">${rest} more</a></span>`;
}

/**
 * The no-photo card's blocks, owner facts only: the hours, grouped, led by an "Emergencies 24/7" row when the
 * owner offers it (so a card that ends "Sun Closed" never stands alone beside a 24/7 promise), then the towns
 * served unless the only town is the city the hero already names. The card sums up the service area and
 * hours section, so it follows that section: none while the owner hides it. None: no card.
 */
function cardBlocks(ctx: RenderContext): SafeHtml[] {
  const { facts } = ctx.doc;
  const blocks: SafeHtml[] = [];
  if (!isVisible(ctx, "serviceArea")) return blocks;
  if (facts.hours.length > 0 || facts.emergency247) {
    const rows = groupedHours(facts.hours, true);
    blocks.push(html`<div class="biz-block"><p class="kicker biz-k">${icon("clock")}Hours</p><dl class="biz-hours">${facts.emergency247 && html`<div class="biz-247"><dt>Emergencies</dt><dd>24/7</dd></div>`}${facts.hours.length > 0 && rows.map((r) => html`<div><dt>${r.label}</dt><dd>${r.value}</dd></div>`)}</dl></div>`);
  }
  const places = facts.serviceArea.places.map((p) => p.trim().toLowerCase());
  if (places.length !== 1 || places[0] !== facts.location.city.trim().toLowerCase()) {
    blocks.push(html`<div class="biz-block"><p class="kicker biz-k">${icon("map-pin")}Serving</p><p class="biz-v">${placesSummary(ctx)}</p></div>`);
  }
  return blocks;
}

export function renderHero(ctx: RenderContext, variant: VariantOf<"hero">): SafeHtml {
  const { facts, copy } = ctx.doc;
  const { flow, surface, trustInHero } = boldPage(ctx);
  const photo = variant === "photo" ? facts.heroPhoto : undefined;
  const items = proofItems(ctx);
  // With no other credential, the card straight under the headline carries 24/7 instead of the chip.
  const chipInProof = trustInHero && facts.emergency247 && facts.licences.length === 0 && !facts.insured && facts.yearFounded === undefined;
  const copyBlock = html`<div class="hero-copy">
<p class="hero-kicker">${facts.emergency247 && !chipInProof && html`<span class="chip">${icon("clock")}24/7 emergency service</span>`}<span class="hero-where">${TRADE_LABEL[facts.trade]} · ${facts.location.city}, ${facts.location.state}</span></p>
<h1 id="${DOM_ID.hero}-title" class="${headlineClass(copy.heroHeadline)}">${copy.heroHeadline}</h1>
${proof(ctx, items)}
<p class="hero-sub">${copy.heroSubheadline}</p>
<div class="hero-actions">${callButton(ctx, "action", true)}${boldPage(ctx).contact && ctaButton(ctx, true)}</div>
</div>`;

  if (photo !== undefined) {
    // When the next band is the page colour, the credentials card becomes its tab (flush with the hero's edge).
    const tab = surface.get(flow[1] ?? "hero") === "paper";
    return html`<section id="${DOM_ID.hero}" class="${tab ? "hero hero--photo hero--tab ink" : "hero hero--photo ink"}" aria-labelledby="${DOM_ID.hero}-title">
<div class="hero-grid">
<div class="hero-media"><img class="hero-img" src="${safeUrl(photo.url, ["https:"])}" width="${photo.width}" height="${photo.height}" alt="${photo.alt}" loading="eager" fetchpriority="high" decoding="async"></div>
${copyBlock}
</div>
</section>`;
  }

  const blocks = cardBlocks(ctx);
  if (blocks.length === 0) {
    // The grid texture is a decorative element of its own, never behind a letter.
    return html`<section id="${DOM_ID.hero}" class="hero hero--type ink" aria-labelledby="${DOM_ID.hero}-title">
<div class="hero-tex" aria-hidden="true"></div>
<div class="hero-grid">
${copyBlock}
</div>
</section>`;
  }
  return html`<section id="${DOM_ID.hero}" class="hero hero--card ink" aria-labelledby="${DOM_ID.hero}-title">
<div class="hero-grid">
${copyBlock}
<div class="biz-slot"><div class="${blocks.length === 1 ? "biz card biz--one" : "biz card"}">${blocks}</div></div>
</div>
</section>`;
}
