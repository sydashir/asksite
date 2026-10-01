// The Bold header: an ink bar with the business name (a link to Home), the site's pages and the phone number; from
// 64rem it sticks, with the owner's call-to-action button always beside the number. From 75rem the pages are inline
// links; below, a full-screen menu holds them with Call and "Get a quote".
// The menu needs no JavaScript: it is a native <details> disclosure, so it opens and closes in place and adds no
// history entry, and Back from another page never lands on a URL that reopens it (A16; a :target menu did).
// The current page's link carries aria-current="page" and a slanted bar, so it is marked by more than colour
// (WCAG 1.4.1). On Contact the header's call-to-action button stays a normal button (moderator ruling f).
import { navItems, pageLink, quoteLink, type RenderContext } from "../../context.ts";
import { formatPhone, telUrl } from "../../format.ts";
import { html, trusted, type SafeHtml } from "../../html.ts";
import { icon } from "./icons.ts";
import { addressMarkup, boldPage, buttonClass, callQuotePair } from "./parts.ts";
import { brandClass } from "./rules.ts";

export function renderHeader(ctx: RenderContext): SafeHtml {
  const { facts, copy } = ctx.doc;
  const { contact } = boldPage(ctx);
  const links = navItems(ctx);
  const current = (isCurrent: boolean) => isCurrent && trusted(' aria-current="page"');

  return html`<header class="site-header">
<div class="wrap header-row">
<a class="${brandClass(facts.businessName)}" href="${pageLink(ctx, "home")}">${addressMarkup(facts.businessName)}</a>
<nav class="nav" aria-label="Main">
<ul class="nav-desktop">${links.map((l) => html`<li><a href="${l.href}"${current(l.current)}>${l.label}</a></li>`)}</ul>
<details class="menu">
<summary class="menu-btn"><span class="sr-only">Menu</span>${icon("menu-2", "ic ic-open")}${icon("x", "ic ic-close")}</summary>
<div class="menu-panel">
<ul class="menu-list">${links.map((l) => html`<li><a href="${l.href}"${current(l.current)}><span>${l.label}</span>${icon("arrow-right")}</a></li>`)}</ul>
<div class="menu-acts">${callQuotePair(ctx)}</div>
</div>
</details>
</nav>
<a class="header-call whitespace-nowrap" href="${telUrl(facts.phone)}"><span class="kicker">${facts.emergency247 ? "Call 24/7" : "Call us"}</span><span class="header-num">${icon("phone")}<span>${formatPhone(facts.phone)}</span></span></a>
${contact && html`<a class="${buttonClass(ctx, "ghost")} header-cta" href="${quoteLink()}">${copy.ctaText}</a>`}
</div>
</header>`;
}
