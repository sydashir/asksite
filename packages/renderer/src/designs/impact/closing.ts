// The Bold closing band (A16): "Get in touch" at the end of every page but Contact, with the Call button (it
// shows the number) and the owner's call to action, which leads to the quote form.
import type { RenderContext } from "../../context.ts";
import { html, type SafeHtml } from "../../html.ts";
import { CLOSING_BAND_ID } from "../../sections/ids.ts";
import { callButton, ctaButton } from "./parts.ts";

export function renderClosingBand(ctx: RenderContext): SafeHtml {
  return html`<section id="${CLOSING_BAND_ID}" class="sec ink" aria-labelledby="${CLOSING_BAND_ID}-title">
<div class="wrap">
<div class="sec-head"><h2 id="${CLOSING_BAND_ID}-title" class="h2 display">Get in touch</h2></div>
<div class="cta-actions">${callButton(ctx, "action")}${ctaButton(ctx)}</div>
</div>
</section>`;
}
