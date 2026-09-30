// The Bold about: the founding year as a large numeral (only when the owner gave one), then the AI's about
// text signed with the business name.
import type { RenderContext } from "../../context.ts";
import { TRADE_LABEL } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { addressMarkup, bandClass, sectionHead } from "./parts.ts";
import { yearClass } from "./rules.ts";

export function renderAbout(ctx: RenderContext): SafeHtml {
  const { facts, copy } = ctx.doc;
  const year = facts.yearFounded;
  const numeral = year !== undefined && html`<p class="year"><span class="kicker">Since</span> <span class="${yearClass(year)}">${year}</span></p>`;

  return html`<section id="${DOM_ID.about}" class="${bandClass(ctx, "about")}" aria-labelledby="${DOM_ID.about}-title">
<div class="wrap about">
${sectionHead("about", "About", "Who we are", undefined, numeral)}
<div class="about-body">
<p class="about-text">${copy.about}</p>
<p class="sign"><span class="sign-name">${addressMarkup(facts.businessName)}</span><span class="sign-meta">${TRADE_LABEL[facts.trade]} · ${facts.location.city}, ${facts.location.state}</span></p>
</div>
</div>
</section>`;
}
