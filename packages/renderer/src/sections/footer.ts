// Ported from AstroWind (MIT, see THIRD_PARTY_NOTICES.md) src/components/widgets/Footer.astro
// at commit 14e1a69. Changes: the astrowind:config coupling (SITE.name, getHomePermalink) is
// replaced by owner facts; link columns are replaced by contact details and credentials
// (licence numbers repeated here because several states require them in all advertising);
// social links are text links; column titles are real <h2> headings; dark:, intersect-* and
// fade classes dropped.
import type { SocialLink } from "@asksite/site-schema";
import { quoteLink, type RenderContext } from "../context.ts";
import { formatPhone, mailtoUrl, telUrl, TRADE_LABEL } from "../format.ts";
import { html, safeUrl, type SafeHtml } from "../html.ts";
import { icon } from "../icons.ts";

const SOCIAL_LABEL: Record<SocialLink["network"], string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  google: "Google",
  yelp: "Yelp",
  nextdoor: "Nextdoor",
  youtube: "YouTube",
  linkedin: "LinkedIn",
};

export function renderFooter(ctx: RenderContext): SafeHtml {
  const { facts } = ctx.doc;
  const { location } = facts;
  const hasCredentials = facts.licences.length > 0 || facts.insured;

  return html`<footer class="border-t border-gray-200">
<div class="mx-auto max-w-7xl px-4 sm:px-6">
<div class="grid grid-cols-12 gap-4 gap-y-8 py-8 sm:gap-8 md:py-12">
<div class="col-span-12 lg:col-span-4">
<p class="mb-2 font-heading text-xl font-bold text-heading">${facts.businessName}</p>
<p class="text-sm text-muted">${TRADE_LABEL[facts.trade]} · ${location.city}, ${location.state}</p>
</div>
<div class="col-span-12 sm:col-span-6 lg:col-span-4">
<h2 class="mb-2 font-medium text-heading">Contact</h2>
<ul class="text-sm">
<li class="mb-2"><a class="inline-block whitespace-nowrap py-1 text-muted hover:text-heading hover:underline" href="${telUrl(facts.phone)}">${formatPhone(facts.phone)}</a></li>
<li class="mb-2"><a class="inline-block break-all py-1 text-muted hover:text-heading hover:underline" href="${mailtoUrl(facts.email)}">${facts.email}</a></li>
${location.streetAddress && html`<li class="mb-2 text-muted">${location.streetAddress}, ${location.city}, ${location.state}${location.postalCode && html` ${location.postalCode}`}</li>`}
</ul>
</div>
${hasCredentials && html`<div class="col-span-12 sm:col-span-6 lg:col-span-4">
<h2 class="mb-2 font-medium text-heading">Credentials</h2>
<ul class="text-sm text-muted">
${facts.licences.map((l) => html`<li class="mb-2">${l.label}: ${l.number}</li>`)}
${facts.insured && html`<li class="mb-2">Insured</li>`}
</ul>
</div>`}
</div>
${facts.socialLinks.length > 0 && html`<div class="border-t border-gray-200 py-6 md:py-8">
<ul class="flex flex-wrap gap-x-6 gap-y-2 text-sm">
${facts.socialLinks.map((s) => html`<li><a class="inline-block py-1 text-muted hover:text-heading hover:underline" href="${safeUrl(s.url, ["https:"])}">${SOCIAL_LABEL[s.network]}</a></li>`)}
</ul>
</div>`}
</div>
</footer>`;
}

/**
 * Phone-only call bar that stays at the bottom of the screen: Call (its accessible name starts with the visible
 * word, WCAG 2.5.3) and Get a quote, which goes to the form on the Contact page. position: sticky needs no JavaScript.
 * An <aside> landmark, so screen-reader users can find it and no content sits outside a landmark.
 * It stops sticking while keyboard focus is elsewhere, so it never hides the focused element.
 */
// Whole class strings, so the stylesheet scan sees them. /contact is the quote form, so its bar sits
// at the end of the page instead of sticking: Send, stacked above a sticky bar, covered its buttons
// on phone windows about 915-1040 px tall (WCAG 2.5.8).
const CALL_BAR_CLASS = {
  sticky: "sticky bottom-0 z-10 border-t border-gray-200 bg-page px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] focus-outside:static md:hidden",
  static: "border-t border-gray-200 bg-page px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] focus-outside:static md:hidden",
} as const;

export function renderCallBar(ctx: RenderContext): SafeHtml {
  const { phone } = ctx.doc.facts;
  const barClass = CALL_BAR_CLASS[ctx.page.id === "contact" ? "static" : "sticky"];
  return html`<aside aria-label="Call us" class="${barClass}">
<div class="grid grid-cols-2 gap-2">
<a class="btn-primary whitespace-nowrap" href="${telUrl(phone)}" aria-label="Call ${formatPhone(phone)}">${icon("phone", "h-5 w-5")}Call</a>
<a class="btn-secondary" href="${quoteLink()}">Get a quote</a>
</div>
</aside>`;
}
