// Pieces every Bold section shares: the page model (which band is ink, the button case), the band shell with its
// heading, and the markup of buttons, licences and addresses.
import type { Facts, PageId, SectionId } from "@asksite/site-schema";
import { contactHeading } from "../../contact-heading.ts";
import { headingLevel, onSite, quoteLink, type RenderContext } from "../../context.ts";
import { formatPhone, telUrl, tradeLabel } from "../../format.ts";
import { html, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { icon } from "./icons.ts";
import { addressParts, buttonCase, licenceParts, pageTitleClass, seamClass, surfaces, type Band, type Surface } from "./rules.ts";

export interface BoldPage {
  /**
   * The page's bands in order (A16): its sections, Home's services preview right before the reviews (last when
   * there are none), the ink head an inner page opens with, and the closing band on every page but Contact. The
   * credentials right under the hero live inside it.
   */
  readonly flow: readonly Band[];
  readonly surface: ReadonlyMap<Band, Surface>;
  /** Home's credentials section sits straight under the hero, so the hero draws it as its proof card. */
  readonly trustInHero: boolean;
  readonly contact: boolean;
  /** Every button on the page in sentence case (the owner's label does not fit in capitals). */
  readonly sentence: boolean;
}

const PAGES = new WeakMap<RenderContext, BoldPage>();

/** The bands of one page, from its sections in the owner's order (U1: never a fixed order). */
function pageFlow(ctx: RenderContext, sections: readonly SectionId[]): Band[] {
  const { id } = ctx.page;
  const flow: Band[] = [...sections];
  if (id === "home") {
    const reviews = flow.indexOf("testimonials");
    flow.splice(reviews === -1 ? flow.length : reviews, 0, "teaser");
  } else if (flow[0] !== "contact") {
    // An inner page opens on ink like Home: the head band with the page's <h1>, inside its first section. The
    // contact band is ink already and carries its own heading.
    flow.unshift("head");
  }
  if (id !== "contact") flow.push("closing");
  return flow;
}

/** The page model, worked out once per page. */
export function boldPage(ctx: RenderContext): BoldPage {
  const known = PAGES.get(ctx);
  if (known !== undefined) return known;
  const ids = ctx.page.sections.map((s) => s.id);
  const trustInHero = ids[0] === "hero" && ids[1] === "trust";
  const flow = pageFlow(ctx, trustInHero ? ids.filter((id) => id !== "trust") : ids);
  // The quote form is on the Contact page, which every site has: a fact about the site, not this page.
  const contact = onSite(ctx, "contact");
  const model: BoldPage = {
    flow,
    surface: surfaces(flow),
    trustInHero,
    contact,
    sentence: contact && buttonCase(ctx.doc.copy.ctaText) === "sentence",
  };
  PAGES.set(ctx, model);
  return model;
}

/** The band's classes: "sec", its surface and the seam it draws. */
export function bandClass(ctx: RenderContext, id: Band): string {
  const { flow, surface } = boldPage(ctx);
  return `sec ${surface.get(id) ?? "paper"}${seamClass(flow, surface, id)}`;
}

/** What a section's heading says: as a band on a page (an h2), and as the <h1> of the inner page it names. */
export interface BandHead {
  /** The section's menu label, over the h2. */
  readonly eyebrow: string;
  /** The h2: Bold's own words. */
  readonly title: string;
  /** The <h1> when the section opens the inner page it names: the words that name the page. */
  readonly pageTitle?: string;
  /** The AI's intro, or the owner's own note. */
  readonly intro?: string | undefined;
}

/**
 * The house heading on a band: an eyebrow (a slanted bar and the section's menu label in small spaced capitals),
 * the h2 and the intro when there is one.
 */
export function sectionHead(domId: string, head: BandHead, classes = "sec-head"): SafeHtml {
  return html`<div class="${classes}"><p class="kicker eyebrow">${head.eyebrow}</p><h2 id="${domId}-title" class="h2 display">${head.title}</h2>${head.intro && html`<p class="sec-intro">${head.intro}</p>`}</div>`;
}

/**
 * The sections that name each inner page: when the owner puts one first, its heading IS the page's <h1> (the
 * contract's words, test/fixtures.test.ts). Contact is named by either of its sections ("Service area & hours" when
 * the owner puts the area first). Another first section (the FAQ on Services) keeps its own h2 under the page's name.
 */
const NAMES: Readonly<Record<PageId, readonly SectionId[]>> = {
  home: [],
  services: ["services"],
  about: ["about"],
  gallery: ["gallery"],
  contact: ["contact", "serviceArea"],
};

/** True when `id` opens its inner page and names it, so the page's <h1> is its heading and its items are h2s. */
export function namesPage(ctx: RenderContext, id: SectionId): boolean {
  return headingLevel(ctx, id) === 1 && NAMES[ctx.page.id].includes(id);
}

/** The level a section's item headings sit under: the page's <h1> (items are h2s) when the section names its page, else its own h2 (items are h3s). */
export function itemLevel(ctx: RenderContext, id: SectionId): 1 | 2 {
  return namesPage(ctx, id) ? 1 : 2;
}

/** The page's own name, the <h1> over a first section that does not name the page (U1: the FAQ first on Services). */
const PAGE_NAME: Readonly<Record<PageId, string>> = { home: "", services: "Our services", about: "About us", gallery: "Our work", contact: "Contact us" };

/** The trade and the town over an inner page's <h1>, as in Home's hero line ("Plumbing · Austin, TX"). */
function pageKicker(ctx: RenderContext): SafeHtml {
  const { facts } = ctx.doc;
  return html`<p class="kicker eyebrow">${tradeLabel(facts)} · ${facts.location.city}, ${facts.location.state}</p>`;
}

/**
 * The owner's standing as chips on an inner page's head, owner facts only: 24/7 service, and Insured and the
 * founding year while the owner shows the credentials section. About leaves them to its credentials list right below
 * (its year is on its photo), so each fact shows once there. On phones the chips are one light line, so "24/7
 * emergency" drops its last word there.
 */
export function trustChips(ctx: RenderContext): SafeHtml | false {
  const { facts } = ctx.doc;
  const shown = onSite(ctx, "trust");
  if (ctx.page.id === "about" && shown) return false;
  const chips = [
    facts.emergency247 && html`<li class="chip">${icon("clock")}<span>24/7 emergency<span class="ph-long"> service</span></span></li>`,
    shown && facts.insured && html`<li class="chip">${icon("shield-check")}Insured</li>`,
    shown && facts.yearFounded !== undefined && ctx.page.id !== "about" && html`<li class="chip">${icon("calendar")}Since ${facts.yearFounded}</li>`,
  ].filter((chip): chip is SafeHtml => chip !== false);
  return chips.length > 0 && html`<ul class="ph-chips">${chips}</ul>`;
}

/**
 * The head band an inner page opens with (A16), on ink like Home's hero: the trade and the town over the page's
 * <h1>, the intro and the owner's standing. Every inner head is the same: the header right above, the call bar and
 * the closing band carry Call and the call to action. Only on Contact (the owner put the service area first) does it
 * carry the number as a call control and the owner's call to action, a jump to the form below, at every width: the
 * call bar there sits at the end of the page (moderator ruling b), so a phone visitor can still call or ask for a
 * quote from the first screen.
 */
function pageHead(ctx: RenderContext, title: string, titleId: string | undefined, intro: string | undefined): SafeHtml {
  const h1 = titleId === undefined ? html`<h1 class="${pageTitleClass(title)}">${title}</h1>` : html`<h1 id="${titleId}" class="${pageTitleClass(title)}">${title}</h1>`;
  const talk = ctx.page.id === "contact" && html`<div class="ph-talk"><p class="kicker">Prefer to talk?</p><p>${bigCall(ctx)}</p><p>${ctaButton(ctx)}</p></div>`;
  return html`<div class="page-head ink"><div class="wrap ph"><div class="page-title">${pageKicker(ctx)}${h1}${intro && html`<p class="sec-intro">${intro}</p>`}${trustChips(ctx)}</div>${talk}</div></div>`;
}

/**
 * The contact band's own heading when the form opens the Contact page: the page's <h1>, the shared contact heading
 * (the owner's call to action, a one-word label in fuller words), with the owner's standing beside the form as on
 * every other inner page's head.
 */
export function contactPageHeading(ctx: RenderContext, domId: string, intro: string | undefined): SafeHtml {
  const title = contactHeading(ctx.doc.copy.ctaText);
  return html`<div class="sec-head contact-head">${pageKicker(ctx)}<h1 id="${domId}-title" class="${pageTitleClass(title)}">${title}</h1>${intro && html`<p class="sec-intro">${intro}</p>`}${trustChips(ctx)}</div>`;
}

/**
 * A section as a Bold band. On Home and below an inner page's first section it is one band with an h2 heading.
 * The first section of an inner page opens the page instead: the ink head band with the page's <h1>, then the
 * content on its own band, both inside the section (A16: no heading outside the sections). When that section
 * names the page (Services on /services) the <h1> is its heading; otherwise (the owner put the FAQ first) the <h1>
 * is the page's name and the section keeps its own h2 on its band.
 */
export function band(ctx: RenderContext, id: SectionId, head: BandHead, layout: string, body: SafeHtml): SafeHtml {
  const domId = DOM_ID[id];
  if (headingLevel(ctx, id) === 2) {
    return html`<section id="${domId}" class="${bandClass(ctx, id)}" aria-labelledby="${domId}-title">
<div class="${layout}">
${sectionHead(domId, head)}
${body}
</div>
</section>`;
  }
  const names = namesPage(ctx, id);
  return html`<section id="${domId}" class="page-open" aria-labelledby="${domId}-title">
${names ? pageHead(ctx, head.pageTitle ?? head.title, `${domId}-title`, head.intro) : pageHead(ctx, PAGE_NAME[ctx.page.id], undefined, undefined)}
<div class="${bandClass(ctx, id)}">
<div class="${layout}">
${names ? body : html`${sectionHead(domId, head)}
${body}`}
</div>
</div>
</section>`;
}

type ButtonKind = "action" | "ghost";

const BUTTON: Readonly<Record<ButtonKind, string>> = { action: "bt bt-action", ghost: "bt bt-ghost" };

/** A button's whole class list: its kind, then the large size and the page's case where they apply. */
export function buttonClass(ctx: RenderContext, kind: ButtonKind, large = false): string {
  return `${BUTTON[kind]}${large ? " bt-lg" : ""}${boldPage(ctx).sentence ? " bt-sc" : ""}`;
}

/**
 * A Call button. Its visible text always holds the number its accessible name reads (WCAG 2.5.3); the word
 * "Call" hides on the narrowest screens and stays in the name.
 */
export function callButton(ctx: RenderContext, kind: ButtonKind, large = false): SafeHtml {
  const { phone } = ctx.doc.facts;
  return html`<a class="${buttonClass(ctx, kind, large)} whitespace-nowrap" href="${telUrl(phone)}" aria-label="Call ${formatPhone(phone)}">${icon("phone")}<span><span class="cb-word">Call </span>${formatPhone(phone)}</span></a>`;
}

/**
 * The number in display type as a call control (Contact, and the closing band): the phone glyph in the action colour
 * beside it, and on phones and tablets the whole of it an action-colour button, so it never reads as a plain heading.
 * Its visible text, the number, is its accessible name.
 */
export function bigCall(ctx: RenderContext): SafeHtml {
  const { phone } = ctx.doc.facts;
  return html`<a class="big-call whitespace-nowrap" href="${telUrl(phone)}"><span class="big-call-ic">${icon("phone")}</span><span class="display">${formatPhone(phone)}</span></a>`;
}

/** The owner's call-to-action button, which leads to the quote form on the Contact page. */
export function ctaButton(ctx: RenderContext, large = false): SafeHtml {
  return html`<a class="${buttonClass(ctx, "ghost", large)}" href="${quoteLink()}">${ctx.doc.copy.ctaText}</a>`;
}

/**
 * The call bar's pair: Call, whose visible words are its accessible name, and the fixed "Get a quote" to the form
 * (moderator ruling, WCAG 2.5.3). The number is always in view: on phones under a small "Call" (the approved bar
 * showed the number), from 36rem on one line with it.
 */
export function callBarPair(ctx: RenderContext): SafeHtml {
  const { phone } = ctx.doc.facts;
  return html`<a class="${buttonClass(ctx, "action")} cb-call whitespace-nowrap" href="${telUrl(phone)}" aria-label="Call ${formatPhone(phone)}">${icon("phone")}<span class="cb-txt"><span class="cb-k">Call</span> <span>${formatPhone(phone)}</span></span></a><a class="${buttonClass(ctx, "ghost")}" href="${quoteLink()}">Get a quote</a>`;
}

/**
 * An email address or a business name, with a <wbr> wherever a long address may break (rules.ts addressParts):
 * "office@<wbr>smithandsons<wbr>.com". The sheet breaks inside a part only when it alone is wider than the line.
 */
export function addressMarkup(text: string): SafeHtml {
  const [first = "", ...rest] = addressParts(text);
  return html`${first}${rest.map((part) => html`<wbr>${part}`)}`;
}

/** A licence: its label, then its number as one unit ("Texas master plumber M-40123"). */
export function licenceMarkup(licence: Facts["licences"][number], labelClass = "lic-label", numberClass = "lic-num"): SafeHtml {
  const { label, number } = licenceParts(licence);
  if (label === "") return html`<span class="${numberClass}">${number}</span>`;
  return html`<span class="${labelClass}">${label}<span class="sr-only">:</span></span> <span class="${numberClass}">${number}</span>`;
}
