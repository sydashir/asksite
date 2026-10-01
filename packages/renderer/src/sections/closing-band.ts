// The closing band at the end of every page but Contact (A16): a way to call or ask for a quote at the foot of
// each page. A render.ts block, not a layout section; its only copy is the AI's call to action, which the hero
// shows too and the claims check has already passed.
import { quoteLink, type RenderContext } from "../context.ts";
import { formatPhone, telUrl } from "../format.ts";
import { html, type SafeHtml } from "../html.ts";
import { icon } from "../icons.ts";
import { headline, sectionShell } from "../ui.ts";
import { CLOSING_BAND_ID } from "./ids.ts";

export function renderClosingBand(ctx: RenderContext): SafeHtml {
  const { facts, copy } = ctx.doc;
  return sectionShell(CLOSING_BAND_ID, "6xl", html`${headline(CLOSING_BAND_ID, "Get in touch")}
<div class="m-auto flex max-w-xs flex-col gap-4 sm:max-w-2xl sm:flex-row sm:justify-center">
<div class="flex w-full sm:w-auto"><a class="btn-primary w-full whitespace-nowrap" href="${telUrl(facts.phone)}">${icon("phone", "h-5 w-5")}${formatPhone(facts.phone)}</a></div>
<div class="flex w-full sm:w-auto"><a class="btn-secondary w-full" href="${quoteLink()}">${copy.ctaText}</a></div>
</div>`);
}
