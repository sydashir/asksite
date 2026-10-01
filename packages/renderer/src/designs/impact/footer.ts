// The Bold footer and phone call bar. The footer is one tone deeper than the ink bands, with the business
// name, the site's pages (on a phone the header's pages sit behind the menu, so the end of a long page is the
// natural way on), how to reach it, the hours while the owner shows them (the service area section) and its
// credentials (licence numbers repeated here, as several states require them in all advertising). The call bar (below 64rem) holds Call and "Get a quote" on every page. It sticks to the
// bottom of the screen and stops sticking while keyboard focus is elsewhere, so it never hides the focused
// element; on Contact it is static, at the end of the page (moderator ruling b, 2026-10-01): that page is the quote
// form, and a sticky bar there met the form's Send button at some phone heights.
import type { SocialLink } from "@asksite/site-schema";
import { navItems, onSite, type RenderContext } from "../../context.ts";
import { formatPhone, mailtoUrl, telUrl, TRADE_LABEL } from "../../format.ts";
import { html, safeUrl, trusted, type SafeHtml } from "../../html.ts";
import { addressMarkup, callBarPair, licenceMarkup } from "./parts.ts";
import { groupedHours } from "./rules.ts";

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
  const current = (isCurrent: boolean) => isCurrent && trusted(' aria-current="page"');
  // The hours sum up the service area section (on the Contact page), so they follow it: none while the owner hides it.
  const hours =
    onSite(ctx, "serviceArea") &&
    facts.hours.length > 0 &&
    html`<h2 class="kicker foot-k">Hours</h2><dl class="foot-hours">${facts.emergency247 && html`<div><dt>Emergencies</dt><dd>24/7</dd></div>`}${groupedHours(facts.hours, true).map((r) => html`<div><dt>${r.label}</dt><dd>${r.value}</dd></div>`)}</dl>`;

  return html`<footer class="site-footer">
<div class="wrap">
<div class="foot-grid">
<div><p class="foot-brand">${addressMarkup(facts.businessName)}</p><p class="foot-sub">${TRADE_LABEL[facts.trade]} · ${location.city}, ${location.state}</p></div>
<nav aria-label="Pages"><h2 class="kicker">Pages</h2><ul>${navItems(ctx).map((l) => html`<li><a href="${l.href}"${current(l.current)}>${l.label}</a></li>`)}</ul></nav>
<div><h2 class="kicker">Contact</h2><ul>
<li><a class="whitespace-nowrap" href="${telUrl(facts.phone)}">${formatPhone(facts.phone)}</a></li>
<li><a class="foot-email" href="${mailtoUrl(facts.email)}">${addressMarkup(facts.email)}</a></li>
${location.streetAddress && html`<li>${location.streetAddress}, ${location.city}, ${location.state}${location.postalCode && html` ${location.postalCode}`}</li>`}
</ul>${hours}</div>
${hasCredentials && html`<div><h2 class="kicker">Credentials</h2><ul>${facts.licences.map((l) => html`<li>${licenceMarkup(l)}</li>`)}${facts.insured && html`<li>Insured</li>`}</ul></div>`}
</div>
${facts.socialLinks.length > 0 && html`<ul class="foot-social">${facts.socialLinks.map((s) => html`<li><a href="${safeUrl(s.url, ["https:"])}">${SOCIAL_LABEL[s.network]}</a></li>`)}</ul>`}
</div>
</footer>`;
}

// Whole class strings, so the stylesheet finds every class.
const CALL_BAR = { sticky: "callbar sticky focus-outside:static", static: "callbar focus-outside:static" } as const;

export function renderCallBar(ctx: RenderContext): SafeHtml {
  return html`<aside aria-label="Call us" class="${CALL_BAR[ctx.page.id === "contact" ? "static" : "sticky"]}">
${callBarPair(ctx)}
</aside>`;
}
