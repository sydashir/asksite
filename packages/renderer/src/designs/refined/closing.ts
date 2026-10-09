// Classic's closing band (A16): "Get in touch" at the foot of every page but Contact, as the contact band ended the
// approved single page. A dark panel on the page's last light band (so it never runs into the dark footer): the
// heading, a question built from the owner's trade and town, the owner's own contact line (or plain house words), the
// hours and the towns served (only while the Service area section renders, amendment A6), then Call with the number
// (and the owner's 24/7 fact) and the owner's call to action word for word, as the hero says it. Wherever the call bar
// shows (phones, and windows under 32rem tall such as a phone held sideways) it carries both buttons, so the panel
// shows the number itself, large, to tap instead (sheet). A render.ts block, not a layout section.
import { quoteLink, type RenderContext } from "../../context.ts";
import { formatPhone, telUrl } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { CLOSING_BAND_ID } from "../../sections/ids.ts";
import { callButton, contactLine, icon, needLine, phoneParts, servingLine, shortHours } from "./parts.ts";
import { bandClass, plan } from "./plan.ts";

export function renderClosingBand(ctx: RenderContext): SafeHtml {
  const { doc } = ctx;
  const { facts } = doc;
  const { areaShown } = plan(ctx);
  const open = areaShown && shortHours(facts);
  const hours = open && html`<li>${icon("clock")}${open}</li>`;
  const towns = areaShown && html`<li>${icon("map-pin")}<span>${servingLine(ctx)}</span></li>`;
  return html`<section id="${CLOSING_BAND_ID}" class="sec cl ${bandClass(ctx, "closing")}" aria-labelledby="${CLOSING_BAND_ID}-title">
<div class="wr">
<div class="cl-p">
<div>
<h2 id="${CLOSING_BAND_ID}-title" class="cl-k">Get in touch</h2>
<p class="cl-t">${needLine(facts)}</p>
<p class="cl-i">${contactLine(doc)}</p>
</div>
<div>
<ul class="cl-l">
<li class="cl-n">${icon("phone", "i i-lg")}<a class="c-ph whitespace-nowrap" href="${telUrl(facts.phone)}">${phoneParts(facts.phone)}</a></li>
${hours}
${towns}
</ul>
<div class="cl-a">
${callButton(facts, "bt bt-act bt-lg", `Call ${formatPhone(facts.phone)}`)}
<a class="bt bt-out bt-lg" href="${quoteLink()}">${doc.copy.ctaText}</a>
</div>
</div>
</div>
</div>
</section>`;
}
