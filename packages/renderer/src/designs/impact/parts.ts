// Pieces every Bold section shares: the page model (which band is ink, the button case), the band shell with its
// heading, and the markup of buttons, licences and addresses.
import type { Facts, SectionId } from "@asksite/site-schema";
import { headingLevel, onSite, quoteLink, type RenderContext } from "../../context.ts";
import { formatPhone, telUrl, TRADE_LABEL } from "../../format.ts";
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

/** What a section's heading says: as a band on a page (an h2), and as the <h1> of the inner page it opens. */
export interface BandHead {
  /** The section's menu label, over the h2. */
  readonly eyebrow: string;
  /** The h2: Bold's own words. */
  readonly title: string;
  /** The <h1> when the section opens an inner page: the words that name the page. */
  readonly pageTitle: string;
  /** The AI's intro, or the owner's own note. */
  readonly intro?: string | undefined;
  /** Shown under an h2 heading (the founding-year numeral). */
  readonly extra?: SafeHtml | false;
}

/**
 * The house heading on a band: an eyebrow (a slanted bar and the section's menu label in small spaced capitals),
 * the h2 and the intro when there is one.
 */
export function sectionHead(domId: string, head: Pick<BandHead, "eyebrow" | "title" | "intro" | "extra">, classes = "sec-head"): SafeHtml {
  return html`<div class="${classes}"><p class="kicker eyebrow">${head.eyebrow}</p><h2 id="${domId}-title" class="h2 display">${head.title}</h2>${head.intro && html`<p class="sec-intro">${head.intro}</p>`}${head.extra}</div>`;
}

/**
 * An inner page's own heading: the trade and the town over the page's <h1>, then the intro. The eyebrow ties the
 * page to Home's hero line ("Plumbing · Austin, TX").
 */
export function pageHeading(ctx: RenderContext, domId: string, title: string, intro: string | undefined, classes = "sec-head"): SafeHtml {
  const { trade, location } = ctx.doc.facts;
  return html`<div class="${classes}"><p class="kicker eyebrow">${TRADE_LABEL[trade]} · ${location.city}, ${location.state}</p><h1 id="${domId}-title" class="${pageTitleClass(title)}">${title}</h1>${intro && html`<p class="sec-intro">${intro}</p>`}</div>`;
}

/**
 * A section as a Bold band. On Home and below an inner page's first section it is one band with an h2 heading;
 * the first section of an inner page opens the page instead: its heading, the page's <h1>, sits on the ink head
 * band and the content follows on its own band, both inside the section (A16: no heading outside the sections).
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
  return html`<section id="${domId}" class="page-open" aria-labelledby="${domId}-title">
<div class="page-head ink"><div class="wrap">${pageHeading(ctx, domId, head.pageTitle, head.intro, "page-title")}</div></div>
<div class="${bandClass(ctx, id)}">
<div class="${layout}">
${body}
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

/** The owner's call-to-action button, which leads to the quote form on the Contact page. */
export function ctaButton(ctx: RenderContext, large = false): SafeHtml {
  return html`<a class="${buttonClass(ctx, "ghost", large)}" href="${quoteLink()}">${ctx.doc.copy.ctaText}</a>`;
}

/**
 * The call bar's (and the phone menu's) pair: Call, whose visible word starts its accessible name, with the number
 * beside it where the bar has room, and the fixed "Get a quote" (moderator ruling, WCAG 2.5.3), to the quote form.
 */
export function callQuotePair(ctx: RenderContext): SafeHtml {
  const { phone } = ctx.doc.facts;
  return html`<a class="${buttonClass(ctx, "action")} whitespace-nowrap" href="${telUrl(phone)}" aria-label="Call ${formatPhone(phone)}">${icon("phone")}<span>Call<span class="cb-num"> ${formatPhone(phone)}</span></span></a><a class="${buttonClass(ctx, "ghost")}" href="${quoteLink()}">Get a quote</a>`;
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
