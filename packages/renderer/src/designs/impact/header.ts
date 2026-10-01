// The Bold header: an ink bar with the business name, the menu and the phone number; from 64rem it sticks,
// with the owner's call-to-action button always beside the number.
// The phone menu needs no JavaScript: the open button links to #menu, the header's own id, and the panel
// shows while the header is the :target. Any link in the panel changes the fragment, so the menu closes after
// a tap; the close button links to "#" (the top of the page, where the header is).
import { navItems, type RenderContext } from "../../context.ts";
import { formatPhone, telUrl } from "../../format.ts";
import { fragment, html, trusted, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { icon } from "./icons.ts";
import { addressMarkup, boldPage, buttonClass, callButton, shortCtaButton } from "./parts.ts";
import { brandClass } from "./rules.ts";

export function renderHeader(ctx: RenderContext): SafeHtml {
  const { facts, copy } = ctx.doc;
  const { contact } = boldPage(ctx);
  const links = navItems(ctx);
  const current = (isCurrent: boolean) => isCurrent && trusted(' aria-current="page"');

  return html`<header class="site-header" id="menu">
<div class="wrap header-row">
<a class="${brandClass(facts.businessName)}" href="${fragment(DOM_ID.hero)}">${addressMarkup(facts.businessName)}</a>
<nav class="nav" aria-label="Main">
<ul class="nav-desktop">${links.map((l) => html`<li><a href="${l.href}"${current(l.current)}>${l.label}</a></li>`)}</ul>
<a class="menu-btn menu-open" href="${fragment("menu")}" aria-controls="menu-panel"><span class="sr-only">Open the menu</span>${icon("menu-2")}</a>
<a class="menu-btn menu-close" href="#"><span class="sr-only">Close the menu</span>${icon("x")}</a>
<div class="menu-panel" id="menu-panel">
<ul class="menu-list">${links.map((l) => html`<li><a href="${l.href}"${current(l.current)}>${l.label}${icon("arrow-right")}</a></li>`)}</ul>
<div class="menu-acts">${callButton(ctx, "action")}${contact && shortCtaButton(ctx)}</div>
</div>
</nav>
<a class="header-call whitespace-nowrap" href="${telUrl(facts.phone)}"><span class="kicker">${facts.emergency247 ? "Call 24/7" : "Call us"}</span><span class="header-num">${icon("phone")}<span>${formatPhone(facts.phone)}</span></span></a>
${contact && html`<a class="${buttonClass(ctx, "ghost")} header-cta" href="${fragment("quote")}">${copy.ctaText}</a>`}
</div>
</header>`;
}
