// Ported from AstroWind (MIT, see THIRD_PARTY_NOTICES.md) src/components/widgets/Contact.astro
// and src/components/ui/Form.astro at commit 14e1a69. Fixes over the original: a real
// <form method="post"> to a configurable https action (the original had no action or method,
// so it sent a GET to the same page); required name and phone; every field has a label and a
// unique id; autocomplete tokens (WCAG 1.3.5); an off-screen honeypot field; text-md (no CSS in
// Tailwind 4.3.3) replaced by text-base; 48px inputs; borders that meet 3:1 non-text contrast. The airy spacing
// keeps Send out of the sticky call bar's band in the first view of a 390 x 900 window (axe target-size at load).
import { QUOTE_ID, type VariantOf } from "@asksite/site-schema";
import { headingLevel, type RenderContext } from "../context.ts";
import { formatPhone, mailtoUrl, telUrl } from "../format.ts";
import { html, type SafeHtml } from "../html.ts";
import { icon } from "../icons.ts";
import { headline, sectionShell } from "../ui.ts";
import { DOM_ID } from "./ids.ts";

const LABEL = "block text-sm font-medium text-heading";
const FIELD = "mt-1 block min-h-12 w-full rounded-lg border border-muted bg-white px-4 py-3 text-base text-default";
// WebKit draws a native <select> at its own font-based height (23-25 px) and ignores its padding,
// so the select drops the native look and draws its own arrow; pr-12 keeps a long service name
// clear of it. The arrow inherits the wrapper's text colour (no colour class of its own), so
// forced-colours mode recolours it with the text, as it does a native arrow. truncate: WebKit counts
// a chosen option's whole text as page width (a 40-character name scrolled a 320 px page 107 px
// sideways), so the select clips it; Chromium also draws an ellipsis there, WebKit does not.
const SELECT_WRAPPER = "relative mt-1 text-default";
const SELECT = "block min-h-12 w-full appearance-none truncate rounded-lg border border-muted bg-white py-3 pr-12 pl-4 text-base text-default";
const SELECT_ARROW = "pointer-events-none absolute top-1/2 right-4 h-5 w-5 -translate-y-1/2";

export function renderContact(ctx: RenderContext, _variant: VariantOf<"contact">): SafeHtml {
  const { facts, copy } = ctx.doc;

  // The email moves to the next line whole and is split only when longer than a line
  // (wrap-anywhere); break-all split addresses that fit ("s / ervice@…").
  return sectionShell(DOM_ID.contact, "7xl", html`${headline(DOM_ID.contact, copy.ctaText, copy.sectionIntros.contact, headingLevel(ctx, "contact"))}
<div class="relative mx-auto flex w-full max-w-xl flex-col rounded-lg border border-gray-200 bg-white p-4 shadow sm:p-6 lg:p-8">
<p class="mb-8 text-default">Prefer to talk? Call <a class="font-semibold whitespace-nowrap text-link underline" href="${telUrl(facts.phone)}">${formatPhone(facts.phone)}</a> or email <a class="font-semibold wrap-anywhere text-link underline" href="${mailtoUrl(facts.email)}">${facts.email}</a>.</p>
<form id="${QUOTE_ID}" action="${ctx.formAction}" method="post">
<div class="mb-8"><label for="contact-name" class="${LABEL}">Name</label><input id="contact-name" name="name" type="text" autocomplete="name" required maxlength="80" class="${FIELD}"></div>
<div class="mb-8"><label for="contact-phone" class="${LABEL}">Phone</label><input id="contact-phone" name="phone" type="tel" autocomplete="tel" required maxlength="30" class="${FIELD}"></div>
<div class="mb-8"><label for="contact-email" class="${LABEL}">Email (optional)</label><input id="contact-email" name="email" type="email" autocomplete="email" maxlength="254" class="${FIELD}"></div>
<div class="mb-8"><label for="contact-service" class="${LABEL}">Service needed (optional)</label><div class="${SELECT_WRAPPER}"><select id="contact-service" name="service" class="${SELECT}">
<option value="">Choose a service</option>
${facts.services.map((s) => html`<option>${s.name}</option>`)}
<option>Something else</option>
</select>${icon("chevron-down", SELECT_ARROW)}</div></div>
<div class="mb-8"><label for="contact-message" class="${LABEL}">How can we help? (optional)</label><textarea id="contact-message" name="message" rows="4" maxlength="2000" class="${FIELD}"></textarea></div>
<div class="absolute -left-[9999px] h-px w-px overflow-hidden" aria-hidden="true"><label for="contact-website">Leave this field empty</label><input id="contact-website" name="website" type="text" tabindex="-1" autocomplete="off"></div>
<div class="mt-8 grid"><button type="submit" class="btn-primary">Send request</button></div>
</form>
</div>`);
}
