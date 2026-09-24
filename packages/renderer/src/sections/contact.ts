// Ported from AstroWind (MIT, see THIRD_PARTY_NOTICES.md) src/components/widgets/Contact.astro
// and src/components/ui/Form.astro at commit 14e1a69. Fixes over the original: a real
// <form method="post"> to a configurable https action (the original had no action or method,
// so it sent a GET to the same page); required name and phone; every field has a label and a
// unique id; autocomplete tokens (WCAG 1.3.5); an off-screen honeypot field; text-md (no CSS in
// Tailwind 4.3.3) replaced by text-base; 48px inputs; borders that meet 3:1 non-text contrast.
import type { VariantOf } from "@asksite/site-schema";
import type { RenderContext } from "../context.ts";
import { formatPhone, mailtoUrl, telUrl } from "../format.ts";
import { html, type SafeHtml } from "../html.ts";
import { headline, sectionShell } from "../ui.ts";
import { DOM_ID } from "./ids.ts";

const LABEL = "block text-sm font-medium text-heading";
const FIELD = "mt-1 block min-h-12 w-full rounded-lg border border-muted bg-white px-4 py-3 text-base text-default";

export function renderContact(ctx: RenderContext, _variant: VariantOf<"contact">): SafeHtml {
  const { facts, copy } = ctx.doc;

  return sectionShell(DOM_ID.contact, "7xl", html`${headline(DOM_ID.contact, copy.ctaText, copy.sectionIntros.contact)}
<div class="relative mx-auto flex w-full max-w-xl flex-col rounded-lg border border-gray-200 bg-white p-4 shadow sm:p-6 lg:p-8">
<p class="mb-6 text-default">Prefer to talk? Call <a class="font-semibold whitespace-nowrap text-link underline" href="${telUrl(facts.phone)}">${formatPhone(facts.phone)}</a> or email <a class="font-semibold break-all text-link underline" href="${mailtoUrl(facts.email)}">${facts.email}</a>.</p>
<form action="${ctx.formAction}" method="post">
<div class="mb-6"><label for="contact-name" class="${LABEL}">Name</label><input id="contact-name" name="name" type="text" autocomplete="name" required maxlength="80" class="${FIELD}"></div>
<div class="mb-6"><label for="contact-phone" class="${LABEL}">Phone</label><input id="contact-phone" name="phone" type="tel" autocomplete="tel" required maxlength="30" class="${FIELD}"></div>
<div class="mb-6"><label for="contact-email" class="${LABEL}">Email (optional)</label><input id="contact-email" name="email" type="email" autocomplete="email" maxlength="254" class="${FIELD}"></div>
<div class="mb-6"><label for="contact-service" class="${LABEL}">Service needed (optional)</label><select id="contact-service" name="service" class="${FIELD}">
<option value="">Choose a service</option>
${facts.services.map((s) => html`<option>${s.name}</option>`)}
<option>Something else</option>
</select></div>
<div class="mb-6"><label for="contact-message" class="${LABEL}">How can we help? (optional)</label><textarea id="contact-message" name="message" rows="4" maxlength="2000" class="${FIELD}"></textarea></div>
<div class="absolute -left-[9999px] h-px w-px overflow-hidden" aria-hidden="true"><label for="contact-website">Leave this field empty</label><input id="contact-website" name="website" type="text" tabindex="-1" autocomplete="off"></div>
<div class="mt-8 grid"><button type="submit" class="btn-primary">Send request</button></div>
</form>
</div>`);
}
