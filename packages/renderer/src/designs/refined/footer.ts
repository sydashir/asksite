// Classic's footer (name, contact, credentials with license numbers, which several states require in
// all advertising, and the owner's social links) and the phone call bar.
import type { SocialLink } from "@asksite/site-schema";
import type { RenderContext } from "../../context.ts";
import { formatPhone, mailtoUrl, telUrl, TRADE_LABEL } from "../../format.ts";
import { fragment, html, safeUrl, type SafeHtml } from "../../html.ts";
import { callButton, ctaShort, email, icon, lic } from "./parts.ts";

const SOCIAL_LABEL: Readonly<Record<SocialLink["network"], string>> = {
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

  return html`<footer class="ft">
<div class="wr ft-grid">
<div>
<p class="ft-name">${facts.businessName}</p>
<p class="ft-trade">${TRADE_LABEL[facts.trade]} · ${location.city}, ${location.state}</p>
</div>
<div>
<h2 class="ft-h">Contact</h2>
<ul>
<li><a class="whitespace-nowrap" href="${telUrl(facts.phone)}">${formatPhone(facts.phone)}</a></li>
<li><a href="${mailtoUrl(facts.email)}">${email(facts.email)}</a></li>
${location.streetAddress && html`<li>${location.streetAddress}, ${location.city}, ${location.state}${location.postalCode && html` ${location.postalCode}`}</li>`}
</ul>
</div>
${hasCredentials && html`<div>
<h2 class="ft-h">Credentials</h2>
<ul>
${facts.licences.map((l) => html`<li>${l.label}: ${lic(l.number)}</li>`)}
${facts.insured && html`<li>Insured</li>`}
</ul>
</div>`}
</div>
${facts.socialLinks.length > 0 && html`<div class="wr">
<ul class="ft-links">
${facts.socialLinks.map((s) => html`<li><a href="${safeUrl(s.url, ["https:"])}">${SOCIAL_LABEL[s.network]}${icon("arrow")}</a></li>`)}
</ul>
</div>`}
</footer>`;
}

/**
 * The phone call bar: Call and the quote button under the thumb, the page's only <aside>. position:
 * sticky needs no JavaScript, and it stops sticking while keyboard focus is elsewhere, so it never hides
 * the focused element (focus-outside:static). Phones only: from 48rem the sticky header carries both.
 */
export function renderCallBar(ctx: RenderContext): SafeHtml {
  const { doc } = ctx;
  return html`<aside aria-label="Call us" class="cb sticky bottom-0 z-10 focus-outside:static">
${callButton(doc.facts, "bt bt-act", html`<span class="cw">Call </span>${formatPhone(doc.facts.phone)}`)}
<a class="bt bt-out" href="${fragment("contact-form")}">${ctaShort(doc)}</a>
</aside>`;
}
