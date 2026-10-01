// The Bold closing band (A16): "Get in touch" on ink at the end of every page but Contact, so every page ends on
// the hero's own pair: Call (it shows the number) and the owner's call to action, to the quote form. The 24/7
// line shows only for an owner who offers 24/7 service. The line under the heading is fixed house copy.
import type { RenderContext } from "../../context.ts";
import { html, type SafeHtml } from "../../html.ts";
import { CLOSING_BAND_ID } from "../../sections/ids.ts";
import { icon } from "./icons.ts";
import { bandClass, callButton, ctaButton, sectionHead } from "./parts.ts";

export function renderClosingBand(ctx: RenderContext): SafeHtml {
  const chip = ctx.doc.facts.emergency247 && html`<p class="close-chip"><span class="chip">${icon("clock")}24/7 emergency calls</span></p>`;
  return html`<section id="${CLOSING_BAND_ID}" class="${bandClass(ctx, "closing")}" aria-labelledby="${CLOSING_BAND_ID}-title">
<div class="wrap close">
${sectionHead(CLOSING_BAND_ID, { eyebrow: "Contact", title: "Get in touch", intro: "Call now, or tell us what you need in a quick request.", extra: chip })}
<div class="close-acts">${callButton(ctx, "action", true)}${ctaButton(ctx, true)}</div>
</div>
</section>`;
}
