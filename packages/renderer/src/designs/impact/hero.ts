// The Bold hero. Text never sits on a photo: it is on a solid ink panel. On phones the owner's photo is a
// band above the text; from 64rem it sits at the right behind a slanted seam (a framed 4:3 window up to 80rem,
// full height beyond), with the credentials card on it. Without a photo the right side holds a card of the
// facts a caller checks first (hours and the towns served); with nothing new for a card the hero is type only. The
// text ends with Call and the owner's call to action; below 64rem the call bar carries Call, so there it ends with
// the call to action alone (impact.css).
import type { VariantOf } from "@asksite/site-schema";
import { onSite, sectionLink, type RenderContext } from "../../context.ts";
import { TRADE_LABEL } from "../../format.ts";
import { html, safeUrl, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { icon } from "./icons.ts";
import { boldPage, callButton, ctaButton, licenceMarkup } from "./parts.ts";
import { groupedHours, headlineClass } from "./rules.ts";

/**
 * Owner facts only, in the two groups the strip never splits: the licences (the first, then the rest behind "+N
 * more") and the owner's standing (Insured and the founding year, or 24/7 service when the card has nothing else).
 */
interface ProofGroups {
  readonly licences: readonly SafeHtml[];
  readonly standing: readonly SafeHtml[];
}

function proofGroups(ctx: RenderContext): ProofGroups {
  const { facts } = ctx.doc;
  // The credentials are the hero's card only while the owner keeps their section straight under the hero. Anywhere
  // else on Home (U1) they are the band there, so each fact shows once (credentials.ts).
  if (!boldPage(ctx).trustInHero) return { licences: [], standing: [] };
  const [first, ...rest] = facts.licences;
  const licences: SafeHtml[] = [];
  if (first !== undefined) {
    licences.push(html`<li class="proof-lic">${icon("certificate")}<span>${licenceMarkup(first, "proof-label", "proof-num")}</span></li>`);
    if (rest.length > 0) {
      const more = `+${rest.length} more ${rest.length === 1 ? "license" : "licenses"}`;
      licences.push(html`<li class="proof-more-li"><details class="proof-more"><summary>${more}</summary><ul>${rest.map((l) => html`<li>${licenceMarkup(l)}</li>`)}</ul></details></li>`);
    }
  }
  const standing: SafeHtml[] = [];
  if (facts.insured) standing.push(html`<li>${icon("shield-check")}<span>Insured</span></li>`);
  if (facts.yearFounded !== undefined) standing.push(html`<li>${icon("calendar")}<span>Since ${facts.yearFounded}</span></li>`);
  if (licences.length === 0 && standing.length === 0 && facts.emergency247) standing.push(html`<li>${icon("clock")}<span>24/7 emergency service</span></li>`);
  return { licences, standing };
}

/**
 * The credentials under the headline: the credentials section itself, straight under the hero, so it keeps its id
 * and label here. Each group is its own list, which the strip moves to the next line whole.
 */
function proof({ licences, standing }: ProofGroups): SafeHtml | false {
  if (licences.length + standing.length === 0) return false;
  return html`<section id="${DOM_ID.trust}" class="proof" aria-label="Credentials">${licences.length > 0 && html`<ul class="proof-list proof-lics">${licences}</ul>`}${standing.length > 0 && html`<ul class="proof-list">${standing}</ul>`}</section>`;
}

/** The towns served: the first three, then "and N more", a link to the service area on the Contact page. */
function placesSummary(ctx: RenderContext): SafeHtml {
  const { places } = ctx.doc.facts.serviceArea;
  const first = places.slice(0, 3).join(", ");
  const rest = places.length - 3;
  if (rest <= 0) return html`${first}`;
  return html`${first} <span class="whitespace-nowrap">and <a href="${sectionLink(ctx, "serviceArea")}">${rest} more</a></span>`;
}

/**
 * The no-photo card's blocks, owner facts only: the hours, grouped, led by an "Emergencies 24/7" row when the
 * owner offers it (so a card that ends "Sun Closed" never stands alone beside a 24/7 promise), then the towns
 * served unless the only town is the city the hero already names. The card sums up the service area and
 * hours section (on the Contact page), so it follows that section: none while the owner hides it. None: no card.
 */
function cardBlocks(ctx: RenderContext): SafeHtml[] {
  const { facts } = ctx.doc;
  const blocks: SafeHtml[] = [];
  if (!onSite(ctx, "serviceArea")) return blocks;
  if (facts.hours.length > 0 || facts.emergency247) {
    const rows = facts.hours.length > 0 ? groupedHours(facts.hours, true) : [];
    blocks.push(html`<div class="biz-block"><p class="kicker biz-k">${icon("clock")}Hours</p><dl class="biz-hours">${facts.emergency247 && html`<div class="biz-247"><dt>Emergencies</dt><dd>24/7</dd></div>`}${rows.map((r) => html`<div><dt>${r.label}</dt><dd>${r.value}</dd></div>`)}</dl></div>`);
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
  const groups = proofGroups(ctx);
  // With no other credential, the card straight under the headline carries 24/7 instead of the chip.
  const chipInProof = trustInHero && facts.emergency247 && facts.licences.length === 0 && !facts.insured && facts.yearFounded === undefined;
  const copyBlock = html`<div class="hero-copy">
<p class="hero-kicker">${facts.emergency247 && !chipInProof && html`<span class="chip">${icon("clock")}24/7 emergency service</span>`}<span class="hero-where">${TRADE_LABEL[facts.trade]} · ${facts.location.city}, ${facts.location.state}</span></p>
<h1 id="${DOM_ID.hero}-title" class="${headlineClass(copy.heroHeadline)}">${copy.heroHeadline}</h1>
${proof(groups)}
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
