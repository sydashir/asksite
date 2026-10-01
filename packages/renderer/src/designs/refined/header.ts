// Classic's header. Phones: the name and a <details> menu, in a header that scrolls away with it. From
// 48rem: every page link is always on show (a second row below 80rem, one row above), and the header stays on
// screen with a quote button and the Call button. The current page's link is marked by weight and an underline,
// not by colour alone (WCAG 1.4.1). Zero JavaScript.
import { navItems, pageLink, quoteLink, type RenderContext } from "../../context.ts";
import { formatPhone } from "../../format.ts";
import { html, trusted, type SafeHtml } from "../../html.ts";
import { callButton, ctaShort, icon } from "./parts.ts";

/** A name longer than this gets a smaller brand and the one-row header only from 90rem. */
const LONG_NAME = 30;

export function renderHeader(ctx: RenderContext): SafeHtml {
  const { doc } = ctx;
  const { facts } = doc;
  const links = navItems(ctx);
  const link = (l: (typeof links)[number]) => html`<li><a href="${l.href}"${l.current && trusted(' aria-current="page"')}>${l.label}</a></li>`;

  // Every page is one step away at every width (WCAG 2.4.5): the link row from 48rem, the menu below it.
  return html`<header class="${facts.businessName.length > LONG_NAME ? "hd hd-long" : "hd"}">
<div class="wr hd-row">
<a class="brand" href="${pageLink(ctx, "home")}">${facts.businessName}</a>
<nav class="nav" aria-label="Main">
<ul class="nav-l">
${links.map(link)}
</ul>
<details class="menu">
<summary><span class="sr-only">Menu</span>${icon("menu-2", "i i-open")}${icon("x", "i i-close")}</summary>
<ul>
${links.map(link)}
</ul>
</details>
</nav>
<a class="bt bt-out hd-q" href="${quoteLink()}">${ctaShort(doc)}</a>
${callButton(facts, "bt bt-act hd-c", html`<span class="sr-only">Call </span>${formatPhone(facts.phone)}`)}
</div>
</header>`;
}
