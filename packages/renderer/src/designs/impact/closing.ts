// The Bold closing band (A16): "Get in touch" at the end of every page but Contact. It leads with the owner's call to
// action in display type (a one-word label in fuller words, rules.ts contactHeading), a line of its own for each page,
// then the number as a call control and the call-to-action button, to the quote form, as Contact's head does. It is
// ink, or light after Home's ink reviews (rules.ts surfaces), so two ink bands never meet; there its content sits on
// an ink panel, so Home still ends on ink as the approved page did. The 24/7 chip shows only for an owner who offers
// 24/7 service. The lines are fixed house copy that claims nothing.
import type { PageId } from "@asksite/site-schema";
import type { RenderContext } from "../../context.ts";
import { html, type SafeHtml } from "../../html.ts";
import { CLOSING_BAND_ID } from "../../sections/ids.ts";
import { icon } from "./icons.ts";
import { bandClass, bigCall, boldPage, ctaButton } from "./parts.ts";
import { contactHeading } from "./rules.ts";

/** The line under the lead, one per page (render.ts draws no closing band on Contact). */
const LINE: Readonly<Record<Exclude<PageId, "contact">, string>> = {
  home: "Questions, or a job in mind? Call us, or send a quick request.",
  services: "Found what you need? Call us, or send a quick request.",
  about: "Like the way we work? Call us, or send a quick request.",
  gallery: "Want work like this at your place? Call us, or send a quick request.",
};

export function renderClosingBand(ctx: RenderContext): SafeHtml {
  const { id } = ctx.page;
  const panel = boldPage(ctx).surface.get("closing") !== "ink";
  const chip = ctx.doc.facts.emergency247 && html`<p class="close-chip"><span class="chip">${icon("clock")}24/7 emergency calls</span></p>`;
  return html`<section id="${CLOSING_BAND_ID}" class="${bandClass(ctx, "closing")}" aria-labelledby="${CLOSING_BAND_ID}-title">
<div class="wrap"><div class="${panel ? "close close--panel ink" : "close"}">
<div class="close-copy"><h2 id="${CLOSING_BAND_ID}-title" class="kicker eyebrow">Get in touch</h2><p class="close-lead h2 display">${contactHeading(ctx.doc.copy.ctaText)}</p>${id !== "contact" && html`<p class="sec-intro">${LINE[id]}</p>`}${chip}</div>
<div class="close-acts"><p class="kicker">Prefer to talk?</p><p>${bigCall(ctx)}</p><p>${ctaButton(ctx, true)}</p></div>
</div></div>
</section>`;
}
