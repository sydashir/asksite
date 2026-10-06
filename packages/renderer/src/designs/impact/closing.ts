// The Bold closing band (A16): "Get in touch" at the end of every page but Contact. Its lead, in display type, adds to
// the button rather than repeating it: the owner's 24/7 promise when the owner offers 24/7 service, else the page's own
// question; then a line, the number as a call control (under "Prefer to talk?" only beside the page's question: under
// "Call us 24/7" that would echo the lead) and the owner's call-to-action button (its words, as on every page: WCAG
// 3.2.4), to the quote form, as Contact's head does. The sheet shows that button only where the call bar is hidden
// (from 64rem), so a screen never offers two quote labels; below, the bar's "Get a quote" carries it (the link stays in
// the page). It is ink, or light after Home's ink reviews
// (rules.ts surfaces), so two ink bands never meet; there its content sits on an ink panel, so Home still ends on ink
// as the approved page did. The words are fixed house copy that claims nothing the owner's facts do not back.
import type { PageId } from "@asksite/site-schema";
import type { RenderContext } from "../../context.ts";
import { html, type SafeHtml } from "../../html.ts";
import { CLOSING_BAND_ID } from "../../sections/ids.ts";
import { bandClass, bigCall, boldPage, ctaButton } from "./parts.ts";

/** Each page's own question. */
const QUESTION: Readonly<Record<Exclude<PageId, "contact">, string>> = {
  home: "Questions, or a job in mind?",
  services: "Found what you need?",
  about: "Like the way we work?",
  gallery: "Want work like this at your place?",
};

const ASK = "Call us, or send a quick request.";

export function renderClosingBand(ctx: RenderContext): SafeHtml {
  const { id } = ctx.page;
  if (id === "contact") return html``; // render.ts draws none there; this narrows the page for QUESTION.
  const panel = boldPage(ctx).surface.get("closing") !== "ink";
  const { emergency247 } = ctx.doc.facts;
  const [lead, line] = emergency247 ? ["Emergency? Call us 24/7.", `${QUESTION[id]} ${ASK}`] : [QUESTION[id], ASK];
  return html`<section id="${CLOSING_BAND_ID}" class="${bandClass(ctx, "closing")}" aria-labelledby="${CLOSING_BAND_ID}-title">
<div class="wrap"><div class="${panel ? "close close--panel ink" : "close"}">
<div class="close-copy"><h2 id="${CLOSING_BAND_ID}-title" class="kicker eyebrow">Get in touch</h2><p class="close-lead h2 display">${lead}</p><p class="sec-intro">${line}</p></div>
<div class="close-acts">${!emergency247 && html`<p class="kicker">Prefer to talk?</p>`}<p>${bigCall(ctx)}</p><p>${ctaButton(ctx, true)}</p></div>
</div></div>
</section>`;
}
