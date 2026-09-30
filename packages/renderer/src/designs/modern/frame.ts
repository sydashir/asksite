// Modern's header, footer and phone call bar.
import type { SocialLink } from "@asksite/site-schema";
import { isVisible, type RenderContext } from "../../context.ts";
import { formatPhone, mailtoUrl, telUrl, TRADE_LABEL } from "../../format.ts";
import { fragment, html, safeUrl, type SafeHtml } from "../../html.ts";
import { icon } from "../../icons.ts";
import { DOM_ID, NAV_LABEL } from "../../sections/ids.ts";
import { LICENSES_ID } from "./hero.ts";
import { emailText, FORM_ID, licenseText } from "./parts.ts";
import { ctaLabels } from "./text.ts";

/** A business name longer than this takes the smaller brand size, so it keeps room beside the menu. */
const LONG_NAME = 30;

/**
 * The header: the business name, the section links (a <details> menu below 1200 px, zero JavaScript) and,
 * from 768 px, a Call button. From 768 px it stays at the top while the page scrolls (styles/sheets/modern.css).
 */
export function renderHeader(ctx: RenderContext): SafeHtml {
  const { facts } = ctx.doc;
  const phone = formatPhone(facts.phone);
  const links = ctx.sections.flatMap((section) => {
    const label = NAV_LABEL[section.id];
    return label ? [html`<li><a href="${fragment(DOM_ID[section.id])}">${label}</a></li>`] : [];
  });
  return html`<header class="hdr">
<div class="wrap bar">
<a class="brand${facts.businessName.length > LONG_NAME ? " brand--long" : ""}" href="${fragment(DOM_ID.hero)}">${facts.businessName}</a>
${links.length > 0 && html`<nav aria-label="Main" class="nav">
<ul class="nav-links">${links}</ul>
<details class="menu"><summary>${icon("menu-2", "i i-open")}${icon("x", "i i-close")}<span>Menu</span></summary><ul class="menu-list">${links}</ul></details>
</nav>`}
<a class="button button-act hdr-call whitespace-nowrap" href="${telUrl(facts.phone)}" aria-label="Call ${phone}">${icon("phone", "i")}${phone}</a>
</div>
</header>`;
}

const SOCIAL_LABEL: Record<SocialLink["network"], string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  google: "Google",
  yelp: "Yelp",
  nextdoor: "Nextdoor",
  youtube: "YouTube",
  linkedin: "LinkedIn",
};

/**
 * The footer on the brand band: the business, how to reach it and every license (several states require them in all
 * advertising), then a closing row under a rule: a copyright line in the business's name (no year: the renderer
 * has no clock) and a way back to the top.
 */
export function renderFooter(ctx: RenderContext): SafeHtml {
  const { facts } = ctx.doc;
  const { location } = facts;
  const credentials = facts.licences.length > 0 || facts.insured;
  return html`<footer class="foot">
<div class="wrap foot-grid">
<div>
<p class="foot-name">${facts.businessName}</p>
<p class="foot-trade">${TRADE_LABEL[facts.trade]} · ${location.city}, ${location.state}</p>
${facts.socialLinks.length > 0 && html`<ul class="foot-social">${facts.socialLinks.map((s) => html`<li><a href="${safeUrl(s.url, ["https:"])}">${SOCIAL_LABEL[s.network]}</a></li>`)}</ul>`}
</div>
<div>
<h2 class="foot-h">Contact</h2>
<ul class="foot-list">
<li><a class="whitespace-nowrap" href="${telUrl(facts.phone)}">${formatPhone(facts.phone)}</a></li>
<li><a href="${mailtoUrl(facts.email)}">${emailText(facts.email)}</a></li>
${location.streetAddress && html`<li>${location.streetAddress}, ${location.city}, ${location.state}${location.postalCode && html` ${location.postalCode}`}</li>`}
</ul>
</div>
${credentials && html`<div id="${LICENSES_ID}">
<h2 class="foot-h">Credentials</h2>
<ul class="foot-list">
${facts.licences.map((l) => html`<li>${l.label} · ${licenseText(l.number)}</li>`)}
${facts.insured && html`<li>Insured</li>`}
</ul>
</div>`}
</div>
<div class="wrap"><div class="foot-end"><p>© ${facts.businessName}</p><a href="${fragment(DOM_ID.hero)}">Back to top</a></div></div>
</footer>`;
}

/**
 * The phone call bar, the page's only <aside>: Call, and the owner's call to action cut to fit (its full short
 * label from 340 px, one word below). It stays at the bottom of the screen below 768 px and stops sticking while
 * keyboard focus is anywhere else (focus-outside:static, styles/shared.css). z-index 10 keeps it under the form's
 * Send button (z-index 20, shared.css), so a tap on Send never lands on the bar.
 */
export function renderCallBar(ctx: RenderContext): SafeHtml {
  const { facts, copy } = ctx.doc;
  const phone = formatPhone(facts.phone);
  const { short, tiny } = ctaLabels(copy.ctaText);
  return html`<aside aria-label="Call us" class="callbar sticky focus-outside:static">
<a class="button button-act whitespace-nowrap" href="${telUrl(facts.phone)}" aria-label="Call ${phone}">${icon("phone", "i")}${phone}</a>
${isVisible(ctx, "contact") && html`<a class="button button-line" href="${fragment(FORM_ID)}">${short === tiny ? short : html`<span class="cta-s">${short}</span><span class="cta-t">${tiny}</span>`}</a>`}
</aside>`;
}
