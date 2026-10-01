// Modern's header, footer and phone call bar.
import type { SocialLink } from "@asksite/site-schema";
import { navItems, pageLink, quoteLink, type RenderContext } from "../../context.ts";
import { formatPhone, mailtoUrl, telUrl, TRADE_LABEL } from "../../format.ts";
import { html, safeUrl, trusted, type SafeHtml } from "../../html.ts";
import { icon } from "../../icons.ts";
import { emailText, LICENSES_ID, licenseText } from "./parts.ts";

/** A business name longer than this takes the smaller brand size, so it keeps room beside the menu. */
const LONG_NAME = 30;

/**
 * The header, the same on every page: the business name (a link to Home), the site's pages (a <details> menu below
 * 1024 px, zero JavaScript; the page on screen marked aria-current), "Get a quote" from 1200 px (the Contact page
 * keeps it as a normal button, moderator ruling (f)) and a Call button from 768 px; phones have the call bar. From
 * 768 px it stays at the top while the page scrolls (styles/sheets/modern.css).
 */
export function renderHeader(ctx: RenderContext): SafeHtml {
  const { facts } = ctx.doc;
  const phone = formatPhone(facts.phone);
  const links = navItems(ctx).map((item) => html`<li><a href="${item.href}"${item.current && trusted(' aria-current="page"')}>${item.label}</a></li>`);
  return html`<header class="hdr">
<div class="wrap bar">
<a class="brand${facts.businessName.length > LONG_NAME ? " brand--long" : ""}" href="${pageLink(ctx, "home")}">${facts.businessName}</a>
<nav aria-label="Main" class="nav">
<ul class="nav-links">${links}</ul>
<details class="menu"><summary>${icon("menu-2", "i i-open")}${icon("x", "i i-close")}<span>Menu</span></summary><ul class="menu-list">${links}</ul></details>
</nav>
<a class="button button-line hdr-quote" href="${quoteLink()}">Get a quote</a>
<a class="button button-act hdr-call whitespace-nowrap" href="${telUrl(facts.phone)}" aria-label="Call ${phone}">${icon("phone", "i")}<span>${phone}</span></a>
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
 * has no clock) and a way back to the top ("#", the top of any page).
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
<div class="wrap"><div class="foot-end"><p>© ${facts.businessName}</p><a href="#">Back to top</a></div></div>
</footer>`;
}

/**
 * The phone call bar, the page's only <aside>: Call (its accessible name carries the number, so the visible word
 * starts it, WCAG 2.5.3) and the fixed words "Get a quote", which lead to the form on the Contact page. Below 768 px
 * it stays at the bottom of the screen and stops sticking while keyboard focus is anywhere else
 * (focus-outside:static, styles/shared.css). On the Contact page, which is the quote form, it is not sticky: it sits
 * at the end of the page, so it never covers the form's Send button (moderator ruling (b), A16), and closes the
 * footer on its brand colour. Where it sticks it stays above the open phone menu's shade (styles/sheets/modern.css), so
 * Call is one tap away with the menu open; no page with a sticky bar has a Send button.
 */
export function renderCallBar(ctx: RenderContext): SafeHtml {
  const { phone } = ctx.doc.facts;
  return html`<aside aria-label="Call us" class="${ctx.page.id === "contact" ? "callbar on-brand focus-outside:static" : "callbar sticky focus-outside:static"}">
<a class="button button-act whitespace-nowrap" href="${telUrl(phone)}" aria-label="Call ${formatPhone(phone)}">${icon("phone", "i")}Call</a>
<a class="button button-line" href="${quoteLink()}">Get a quote</a>
</aside>`;
}
