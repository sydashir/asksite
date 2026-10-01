// Classic's closing band (A16): the dark "Get in touch" band that ends every page but Contact, as the contact band
// ends today's Home, so a visitor can call or ask for a quote at the foot of every page. The Call button shows the
// number (and the owner's 24/7 fact); the quote button carries the owner's call to action word for word (the A16
// contract), which the claims check has already passed. A render.ts block, not a layout section.
import { quoteLink, type RenderContext } from "../../context.ts";
import { formatPhone } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { CLOSING_BAND_ID } from "../../sections/ids.ts";
import { callButton, sectionHead } from "./parts.ts";

export function renderClosingBand(ctx: RenderContext): SafeHtml {
  const { facts } = ctx.doc;
  return html`<section id="${CLOSING_BAND_ID}" class="sec dark cl" aria-labelledby="${CLOSING_BAND_ID}-title">
<div class="wr cl-w">
${sectionHead(CLOSING_BAND_ID, "Get in touch")}
<div class="cl-a">
${callButton(facts, "bt bt-act bt-lg", `Call ${formatPhone(facts.phone)}`)}
<a class="bt bt-out bt-lg" href="${quoteLink()}">${ctx.doc.copy.ctaText}</a>
</div>
</div>
</section>`;
}
