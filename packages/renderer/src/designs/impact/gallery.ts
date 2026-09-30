// The Bold gallery: a layout picked by the number of photos, so every row is complete and no tile is taller
// than 4:3. Captions sit under the photo in one style; a tile without one keeps the caption line empty.
import type { RenderContext } from "../../context.ts";
import { html, safeUrl, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { bandClass, sectionHead } from "./parts.ts";
import { galleryClass } from "./rules.ts";

export function renderGallery(ctx: RenderContext): SafeHtml {
  const { facts, copy } = ctx.doc;
  const tiles = facts.photos.map((p) => {
    const figure = html`<figure><div class="gal-img"><img src="${safeUrl(p.url, ["https:"])}" width="${p.width}" height="${p.height}" alt="${p.alt}" loading="lazy" decoding="async"></div>${p.caption && html`<figcaption>${p.caption}</figcaption>`}</figure>`;
    return p.caption === undefined ? html`<li class="nocap">${figure}</li>` : html`<li>${figure}</li>`;
  });

  return html`<section id="${DOM_ID.gallery}" class="${bandClass(ctx, "gallery")}" aria-labelledby="${DOM_ID.gallery}-title">
<div class="wrap">
${sectionHead("gallery", "Our work", "On the job", copy.sectionIntros.gallery)}
<ul class="${galleryClass(tiles.length)}">${tiles}</ul>
</div>
</section>`;
}
