// Classic's closing band (A16): "Get in touch" at the foot of every page but Contact, as the contact band ended the
// approved single page. A dark panel on the page's last light band (so it never runs into the dark footer): the
// heading, a question built from the owner's trade and town, the owner's own contact line (or plain house words), the
// hours and the towns served (only while the Service area section renders, amendment A6, and never twice on Home: the
// business card that stands in for a hero photo lists them), then Call with the number (and the owner's 24/7 fact) and
// the owner's call to action, in the words the hero uses. On phones the call bar under the thumb carries both actions,
// so the panel leaves its buttons out there. A render.ts block, not a layout section.
import { quoteLink, type RenderContext } from "../../context.ts";
import { formatPhone } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { CLOSING_BAND_ID } from "../../sections/ids.ts";
import { callButton, contactLine, ctaLong, dots, groupedHours, icon, needLine, townSummary } from "./parts.ts";
import { bandClass, plan } from "./plan.ts";

/** More open rows than this make the hours too long for one line: the Contact page lists them. */
const HOURS_ROWS = 2;

export function renderClosingBand(ctx: RenderContext): SafeHtml {
  const { doc } = ctx;
  const { facts } = doc;
  const { areaShown, cardHours, photo } = plan(ctx);
  // Home's business card (no hero photo) already lists the towns and the hours: the band does not repeat them.
  const card = ctx.page.id === "home" && !photo;
  const open = groupedHours(facts.hours).filter((row) => row.time !== "Closed");
  const hours = areaShown && !(card && cardHours) && open.length > 0 && open.length <= HOURS_ROWS && html`<li>${icon("clock")}${dots(open.map((row) => ({ text: `${row.label} ${row.time}` })))}</li>`;
  const towns = areaShown && !card && html`<li>${icon("map-pin")}<span>Serving ${townSummary(ctx)}</span></li>`;
  return html`<section id="${CLOSING_BAND_ID}" class="sec cl ${bandClass(ctx, "closing")}" aria-labelledby="${CLOSING_BAND_ID}-title">
<div class="wr">
<div class="cl-p">
<div>
<h2 id="${CLOSING_BAND_ID}-title" class="cl-k">Get in touch</h2>
<p class="cl-t">${needLine(facts)}</p>
<p class="cl-i">${contactLine(doc)}</p>
</div>
<div>
${(hours || towns) && html`<ul class="cl-l">
${hours}
${towns}
</ul>`}
<div class="cl-a">
${callButton(facts, "bt bt-act bt-lg", `Call ${formatPhone(facts.phone)}`)}
<a class="bt bt-out bt-lg" href="${quoteLink()}">${ctaLong(doc)}</a>
</div>
</div>
</div>
</div>
</section>`;
}
