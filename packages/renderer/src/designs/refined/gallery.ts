// Classic's gallery, the Gallery page's one section: the owner's photos as framed prints, each caption under its own
// print. Zero JavaScript, lazy-loaded. The page exists to show the work, so the prints are page-sized: one per row on
// phones, two per row on tablets (an odd count opens with one full-width print), and on desktops a plan by count so no
// row ends with one print alone: 2 and 4 in two big columns, 3, 6, 9 and 12 open with a lead print, 5 opens with a
// lead print and a stacked pair over two halves, 7 and 10 with one wide print; one print sits beside the heading.
// When any print has a caption, every print keeps a caption line, so rows keep one rhythm.
import type { RenderContext } from "../../context.ts";
import { html, safeUrl, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { sectionTitle } from "./parts.ts";
import { bandClass } from "./plan.ts";

function gridClass(count: number): string {
  if (count === 1) return "gal g-1";
  if (count === 2 || count === 4) return "gal";
  if (count === 5) return "gal g-5";
  if (count % 3 === 0) return "gal g-lead";
  return count % 3 === 1 ? "gal g-wide" : "gal g-3";
}

export function renderGallery(ctx: RenderContext): SafeHtml {
  const { facts, copy } = ctx.doc;
  const count = facts.photos.length;
  const captions = facts.photos.some((p) => p.caption !== undefined);

  return html`<section id="${DOM_ID.gallery}" class="sec ${bandClass(ctx, "gallery")}" aria-labelledby="${DOM_ID.gallery}-title">
<div class="${count === 1 ? "wr solo" : "wr"}">
${sectionTitle(ctx, "gallery", "Our work", copy.sectionIntros.gallery)}
<ul class="${captions ? `${gridClass(count)} gal-c` : gridClass(count)}">
${facts.photos.map((p) => html`<li><figure class="print"><img src="${safeUrl(p.url, ["https:"])}" width="${p.width}" height="${p.height}" alt="${p.alt}" loading="lazy" decoding="async">${p.caption !== undefined && html`<figcaption>${p.caption}</figcaption>`}</figure></li>`)}
</ul>
</div>
</section>`;
}
