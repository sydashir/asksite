// Our own header (AstroWind's Header.astro is 309 lines of features we do not need).
// Zero JavaScript: the phone menu is a native <details> disclosure.
import { navItems, pageLink, type RenderContext } from "../context.ts";
import { formatPhone, telUrl } from "../format.ts";
import { html, trusted, type SafeHtml } from "../html.ts";
import { icon } from "../icons.ts";

// Desktop nav labels never wrap ("Our / work" looks broken). Below xl (1280 px) the links are
// smaller and tighter, so a long business name keeps room beside all five of them. The current page's
// link is bold, darker and underlined (more than colour alone, WCAG 1.4.1); whole class strings, so
// the stylesheet finds every class.
const DESKTOP_LINK = {
  other: "inline-flex min-h-11 items-center whitespace-nowrap rounded-md px-2 text-sm font-medium text-default hover:text-primary xl:text-base",
  current: "inline-flex min-h-11 items-center whitespace-nowrap rounded-md px-2 text-sm font-semibold text-heading underline decoration-2 underline-offset-8 xl:text-base",
} as const;
const MENU_LINK = {
  other: "flex min-h-11 items-center rounded-md px-3 font-medium text-default hover:bg-gray-100",
  current: "flex min-h-11 items-center rounded-md px-3 font-semibold text-heading underline decoration-2 underline-offset-4 hover:bg-gray-100",
} as const;

export function renderHeader(ctx: RenderContext): SafeHtml {
  const { facts } = ctx.doc;
  const phone = formatPhone(facts.phone);
  const links = navItems(ctx);
  const current = (isCurrent: boolean) => isCurrent && trusted(' aria-current="page"');

  return html`<header class="border-b border-gray-200 bg-page">
<div class="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
<a class="mr-auto min-w-0 font-heading text-lg font-bold leading-tight text-heading sm:text-xl" href="${pageLink(ctx, "home")}">${facts.businessName}</a>
<nav aria-label="Main" class="order-last lg:order-none">
<ul class="hidden items-center gap-1 lg:flex">
${links.map((l) => html`<li><a class="${DESKTOP_LINK[l.current ? "current" : "other"]}" href="${l.href}"${current(l.current)}>${l.label}</a></li>`)}
</ul>
<details class="group relative lg:hidden">
<summary class="flex h-11 w-11 cursor-pointer list-none items-center justify-center rounded-md text-heading hover:bg-gray-100 [&::-webkit-details-marker]:hidden">
<span class="sr-only">Menu</span>
${icon("menu-2", "h-6 w-6 group-open:hidden")}
${icon("x", "hidden h-6 w-6 group-open:block")}
</summary>
<ul class="absolute right-0 z-20 mt-2 w-60 rounded-lg border border-gray-200 bg-page p-2 shadow-lg">
${links.map((l) => html`<li><a class="${MENU_LINK[l.current ? "current" : "other"]}" href="${l.href}"${current(l.current)}>${l.label}</a></li>`)}
</ul>
</details>
</nav>
<a class="btn-primary shrink-0 whitespace-nowrap" href="${telUrl(facts.phone)}" aria-label="Call ${phone}">${icon("phone", "h-5 w-5")}<span class="sm:hidden">Call</span><span class="hidden sm:inline">${phone}</span></a>
</div>
</header>`;
}
