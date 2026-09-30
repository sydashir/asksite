// Classic's header. Phones: the name and a <details> menu, in a header that scrolls away with it. From
// 48rem: the section links are always on show (a second row below 80rem, one row above), and the header
// stays on screen with a quote button and the Call button. Zero JavaScript.
import type { RenderContext } from "../../context.ts";
import { formatPhone } from "../../format.ts";
import { fragment, html, type SafeHtml } from "../../html.ts";
import { DOM_ID, NAV_LABEL } from "../../sections/ids.ts";
import { callButton, ctaShort, icon } from "./parts.ts";

/** A name longer than this gets a smaller brand and the one-row header only from 90rem. */
const LONG_NAME = 30;

export function renderHeader(ctx: RenderContext): SafeHtml {
  const { doc } = ctx;
  const { facts } = doc;
  const links = ctx.sections.flatMap((section) => {
    const label = NAV_LABEL[section.id];
    return label === undefined ? [] : [{ id: section.id, href: fragment(DOM_ID[section.id]), label }];
  });
  const link = (l: (typeof links)[number]) => html`<li><a href="${l.href}">${l.label}</a></li>`;

  // From 48rem the quote button goes to the form, so the link row leaves "Contact" out; the phone menu keeps it.
  return html`<header class="${facts.businessName.length > LONG_NAME ? "hd hd-long" : "hd"}">
<div class="wr hd-row">
<a class="brand" href="${fragment(DOM_ID.hero)}">${facts.businessName}</a>
${links.length > 0 && html`<nav class="nav" aria-label="Main">
<ul class="nav-l">
${links.filter((l) => l.id !== "contact").map(link)}
</ul>
<details class="menu">
<summary><span class="sr-only">Menu</span>${icon("menu-2", "i i-open")}${icon("x", "i i-close")}</summary>
<ul>
${links.map(link)}
</ul>
</details>
</nav>`}
<a class="bt bt-out hd-q" href="${fragment("contact-form")}">${ctaShort(doc)}</a>
${callButton(facts, "bt bt-act hd-c", html`<span class="sr-only">Call </span>${formatPhone(facts.phone)}`)}
</div>
</header>`;
}
