// Classic's About: the owner's story as a letter on a paper card, with an initial, a diamond rule and a
// sign-off with the trade and town. On its own page the letter's title is the page's <h1> (A16).
import { headingLevel, type RenderContext } from "../../context.ts";
import { TRADE_LABEL } from "../../format.ts";
import { html, trusted, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { bandClass } from "./plan.ts";

export function renderAbout(ctx: RenderContext): SafeHtml {
  const { facts, copy } = ctx.doc;
  const { city, state } = facts.location;
  const title = `About ${facts.businessName}`;

  return html`<section id="${DOM_ID.about}" class="sec ${bandClass(ctx, "about")}" aria-labelledby="${DOM_ID.about}-title">
<div class="wr">
<div class="letter">
${headingLevel(ctx, "about") === 1 ? html`<h1 id="${DOM_ID.about}-title" class="st">${title}</h1>` : html`<h2 id="${DOM_ID.about}-title" class="st">${title}</h2>`}
<svg class="rule" viewBox="0 0 112 12" aria-hidden="true">${trusted('<path d="M0 6h44m24 0h44" stroke="currentColor" stroke-width="1.5"/><path d="M56 1l5 5l-5 5l-5-5z" fill="currentColor"/>')}</svg>
<p class="letter-b">${copy.about}</p>
<p class="letter-s">${facts.businessName}<span>${TRADE_LABEL[facts.trade]} · ${city}, ${state}</span></p>
</div>
</div>
</section>`;
}
