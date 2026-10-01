// Ported from AstroWind (MIT, see THIRD_PARTY_NOTICES.md) src/components/widgets/Gallery.astro
// at commit 14e1a69. The JavaScript lightbox (<aw-gallery>, <dialog>, <script>) is NOT ported:
// this is a plain zero-JS grid of owner photos with lazy loading and optional captions.
// Column count follows the number of photos (lookup table, whole class strings).
import type { VariantOf } from "@asksite/site-schema";
import { headingLevel, type RenderContext } from "../context.ts";
import { html, safeUrl, type SafeHtml } from "../html.ts";
import { headline, sectionShell } from "../ui.ts";
import { DOM_ID } from "./ids.ts";

const GRID = {
  one: "mx-auto grid max-w-3xl grid-cols-1 gap-4",
  two: "grid grid-cols-1 gap-4 sm:grid-cols-2 md:gap-6",
  many: "grid grid-cols-1 gap-4 sm:grid-cols-2 md:gap-6 lg:grid-cols-3",
} as const;

export function renderGallery(ctx: RenderContext, _variant: VariantOf<"gallery">): SafeHtml {
  const { facts, copy } = ctx.doc;
  const count = facts.photos.length;
  const grid = count === 1 ? GRID.one : count === 2 || count === 4 ? GRID.two : GRID.many;

  return sectionShell(DOM_ID.gallery, "6xl", html`${headline(DOM_ID.gallery, "Our work", copy.sectionIntros.gallery, headingLevel(ctx, "gallery"))}
<ul class="${grid}">
${facts.photos.map((p) => html`<li>
<figure>
<img class="aspect-[4/3] w-full rounded-lg bg-gray-100 object-cover" src="${safeUrl(p.url, ["https:"])}" width="${p.width}" height="${p.height}" alt="${p.alt}" loading="lazy" decoding="async">
${p.caption && html`<figcaption class="mt-2 text-sm text-muted">${p.caption}</figcaption>`}
</figure>
</li>`)}
</ul>`);
}
