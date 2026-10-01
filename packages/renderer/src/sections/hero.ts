// Ported from AstroWind (MIT, see THIRD_PARTY_NOTICES.md) src/components/widgets/Hero.astro
// at commit 14e1a69. Changes: the 76px fixed-header offsets are removed (our header is not
// fixed); the badge and tagline are built from owner facts; actions are capped at a call
// button plus one quote button; the image is a plain <img> (no Astro image pipeline);
// set:html, dark:, intersect-* and fade classes removed; text-balance added to the h1.
import type { VariantOf } from "@asksite/site-schema";
import { quoteLink, type RenderContext } from "../context.ts";
import { formatPhone, telUrl, TRADE_LABEL } from "../format.ts";
import { html, safeUrl, type SafeHtml } from "../html.ts";
import { icon } from "../icons.ts";
import { DOM_ID } from "./ids.ts";

const TEXT_BLOCK = {
  withPhoto: "mx-auto max-w-5xl pb-10 text-center md:pb-16",
  textOnly: "mx-auto max-w-5xl text-center",
} as const;

// Each tagline part is an inline-block, so a line breaks only between parts ("Since" / "1998" never
// splits) and a part wraps inside itself only when it alone is wider than the line. whitespace-nowrap
// would push the page sideways instead: a 40-character city is wider than a phone. The no-break
// space keeps each "·" at the end of its part's line; text-balance evens out the lines.
const TAGLINE_PART = "inline-block max-w-full";

function taglineParts(parts: readonly string[]): SafeHtml[] {
  return parts.map((part, i) =>
    i < parts.length - 1 ? html`<span class="${TAGLINE_PART}">${part}\u00a0·</span> ` : html`<span class="${TAGLINE_PART}">${part}</span>`,
  );
}

export function renderHero(ctx: RenderContext, variant: VariantOf<"hero">): SafeHtml {
  const { facts, copy } = ctx.doc;
  const photo = variant === "photo" ? facts.heroPhoto : undefined;
  const tagline = taglineParts(
    [
      TRADE_LABEL[facts.trade],
      `${facts.location.city}, ${facts.location.state}`,
      facts.yearFounded === undefined ? undefined : `Since ${facts.yearFounded}`,
    ].filter((part) => part !== undefined),
  );

  return html`<section id="${DOM_ID.hero}" aria-labelledby="${DOM_ID.hero}-title">
<div class="mx-auto max-w-7xl px-4 sm:px-6">
<div class="py-12 md:py-20">
<div class="${photo ? TEXT_BLOCK.withPhoto : TEXT_BLOCK.textOnly}">
${facts.emergency247 && html`<p class="mb-4 inline-block rounded-full bg-accent px-3 py-1 text-xs font-semibold tracking-wide text-heading uppercase">24/7 emergency service</p>`}
<p class="text-base font-bold tracking-wide text-balance text-secondary uppercase">${tagline}</p>
<h1 id="${DOM_ID.hero}-title" class="mb-4 font-heading text-4xl font-bold leading-tight tracking-tighter text-balance text-heading sm:text-5xl md:text-6xl">${copy.heroHeadline}</h1>
<div class="mx-auto max-w-3xl">
<p class="mb-6 text-xl text-pretty text-muted">${copy.heroSubheadline}</p>
<div class="m-auto flex max-w-xs flex-col flex-nowrap gap-4 sm:max-w-2xl sm:flex-row sm:justify-center">
<div class="flex w-full sm:w-auto"><a class="btn-primary w-full whitespace-nowrap" href="${telUrl(facts.phone)}">${icon("phone", "h-5 w-5")}Call ${formatPhone(facts.phone)}</a></div>
<div class="flex w-full sm:w-auto"><a class="btn-secondary w-full" href="${quoteLink()}">${copy.ctaText}</a></div>
</div>
</div>
</div>
${photo && html`<div class="relative m-auto max-w-5xl">
<img class="mx-auto aspect-video w-full rounded-md object-cover" src="${safeUrl(photo.url, ["https:"])}" width="${photo.width}" height="${photo.height}" alt="${photo.alt}" loading="eager" fetchpriority="high" decoding="async">
</div>`}
</div>
</div>
</section>`;
}
