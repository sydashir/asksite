// The Bold footer and phone call bar. The footer is one tone deeper than the ink bands, with the business
// name, how to reach it and its credentials (licence numbers repeated here, as several states require them
// in all advertising). The call bar (below 64rem) sticks to the bottom of the screen with Call and the call to
// action, and stops sticking while keyboard focus is elsewhere, so it never hides the focused element.
import type { SocialLink } from "@asksite/site-schema";
import type { RenderContext } from "../../context.ts";
import { formatPhone, mailtoUrl, telUrl, TRADE_LABEL } from "../../format.ts";
import { html, safeUrl, type SafeHtml } from "../../html.ts";
import { addressMarkup, boldPage, callButton, licenceMarkup, shortCtaButton } from "./parts.ts";

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

  return html`<footer class="site-footer">
<div class="wrap">
<div class="foot-grid">
<div><p class="foot-brand">${addressMarkup(facts.businessName)}</p><p class="foot-sub">${TRADE_LABEL[facts.trade]} · ${location.city}, ${location.state}</p></div>
<div><h2 class="kicker">Contact</h2><ul>
<li><a class="whitespace-nowrap" href="${telUrl(facts.phone)}">${formatPhone(facts.phone)}</a></li>
<li><a class="foot-email" href="${mailtoUrl(facts.email)}">${addressMarkup(facts.email)}</a></li>
${location.streetAddress && html`<li>${location.streetAddress}, ${location.city}, ${location.state}${location.postalCode && html` ${location.postalCode}`}</li>`}
</ul></div>
${hasCredentials && html`<div><h2 class="kicker">Credentials</h2><ul>${facts.licences.map((l) => html`<li>${licenceMarkup(l)}</li>`)}${facts.insured && html`<li>Insured</li>`}</ul></div>`}
</div>
${facts.socialLinks.length > 0 && html`<ul class="foot-social">${facts.socialLinks.map((s) => html`<li><a href="${safeUrl(s.url, ["https:"])}">${SOCIAL_LABEL[s.network]}</a></li>`)}</ul>`}
</div>
</footer>`;
}

export function renderCallBar(ctx: RenderContext): SafeHtml {
  return html`<aside aria-label="Call us" class="callbar sticky focus-outside:static">
${callButton(ctx, "action")}${boldPage(ctx).contact && shortCtaButton(ctx)}
</aside>`;
}
