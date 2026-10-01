// Classic's closing band (A16): the "Get in touch" band that ends every page but Contact, with the Call button and
// the owner's call to action. A render.ts block, not a layout section.
import { quoteLink, type RenderContext } from "../../context.ts";
import { formatPhone } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { CLOSING_BAND_ID } from "../../sections/ids.ts";
import { callButton, ctaLong, sectionHead } from "./parts.ts";

export function renderClosingBand(ctx: RenderContext): SafeHtml {
  const { facts } = ctx.doc;
  return html`<section id="${CLOSING_BAND_ID}" class="sec dark" aria-labelledby="${CLOSING_BAND_ID}-title">
<div class="wr">
${sectionHead(CLOSING_BAND_ID, "Get in touch")}
${callButton(facts, "bt bt-act bt-lg", formatPhone(facts.phone))}
<a class="bt bt-out bt-lg" href="${quoteLink()}">${ctaLong(ctx.doc)}</a>
</div>
</section>`;
}
