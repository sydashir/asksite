// Classic's gallery: the owner's photos as framed prints of one size, each caption under its own print.
// Zero JavaScript, lazy-loaded. The column plan follows the count, so no row ends with one print alone:
// 3, 6, 9 and 12 open with a large lead print, 7 and 10 with one wide print; one print sits beside the
// heading from 60rem.
import type { RenderContext } from "../../context.ts";
import { html, safeUrl, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { ctaRow, sectionHead } from "./parts.ts";
import { plan } from "./plan.ts";

function gridClass(count: number): string {
  if (count === 1) return "gal g-1";
  if (count === 2) return "gal g-2";
  if (count === 4) return "gal g-4";
  if (count % 3 === 0) return "gal g-lead";
  return count % 3 === 1 ? "gal g-wide" : "gal";
}

export function renderGallery(ctx: RenderContext): SafeHtml {
  const { facts, copy } = ctx.doc;
  const { band, ctaAfter } = plan(ctx);
  const count = facts.photos.length;

  return html`<section id="${DOM_ID.gallery}" class="${band.gallery === "white" ? "sec bw" : "sec bp"}" aria-labelledby="${DOM_ID.gallery}-title">
<div class="${count === 1 ? "wr solo" : "wr"}">
${sectionHead(DOM_ID.gallery, "Our work", copy.sectionIntros.gallery)}
<ul class="${gridClass(count)}">
${facts.photos.map((p) => html`<li><figure class="print"><img src="${safeUrl(p.url, ["https:"])}" width="${p.width}" height="${p.height}" alt="${p.alt}" loading="lazy" decoding="async">${p.caption !== undefined && html`<figcaption>${p.caption}</figcaption>`}</figure></li>`)}
</ul>
${ctaAfter === "gallery" && ctaRow(ctx.doc)}
</div>
</section>`;
}
