// The Bold gallery: a layout picked by the number of photos, so every row is complete and no tile is taller
// than 4:3 (one photo spans the row). Each photo links to its own full-size file, so a phone visitor can open it
// and zoom in on the work, with no JavaScript. Captions sit under the photo in one style; a tile without one keeps
// the caption line empty. The section opens the Gallery page, so its heading is the page's <h1> there (A16).
import type { RenderContext } from "../../context.ts";
import { html, safeUrl, type SafeHtml } from "../../html.ts";
import { band } from "./parts.ts";
import { galleryClass } from "./rules.ts";

export function renderGallery(ctx: RenderContext): SafeHtml {
  const { facts, copy } = ctx.doc;
  const tiles = facts.photos.map((p) => {
    const url = safeUrl(p.url, ["https:"]);
    const figure = html`<figure><a class="gal-img" href="${url}"><img src="${url}" width="${p.width}" height="${p.height}" alt="${p.alt}" loading="lazy" decoding="async"></a>${p.caption && html`<figcaption>${p.caption}</figcaption>`}</figure>`;
    return p.caption === undefined ? html`<li class="nocap">${figure}</li>` : html`<li>${figure}</li>`;
  });

  return band(
    ctx,
    "gallery",
    { eyebrow: "Our work", title: "On the job", pageTitle: "Our work", intro: copy.sectionIntros.gallery },
    "wrap",
    html`<ul class="${galleryClass(tiles.length)}">${tiles}</ul>`,
  );
}
