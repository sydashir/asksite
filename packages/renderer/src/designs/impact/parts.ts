// Pieces every Bold section shares: the page model (which band is ink, the button case) and the markup of
// buttons, section heads and licences.
import type { Facts, SectionId } from "@asksite/site-schema";
import { isVisible, type RenderContext } from "../../context.ts";
import { formatPhone, telUrl } from "../../format.ts";
import { fragment, html, type SafeHtml } from "../../html.ts";
import { DOM_ID } from "../../sections/ids.ts";
import { icon } from "./icons.ts";
import { buttonCase, licenceParts, seamClass, shortCta, surfaces, type Surface } from "./rules.ts";

export interface BoldPage {
  /** The sections drawn as their own band, in page order (credentials right under the hero live inside it). */
  readonly flow: readonly SectionId[];
  readonly surface: ReadonlyMap<SectionId, Surface>;
  /** The credentials section sits straight under the hero, so the hero draws it as its proof card. */
  readonly trustInHero: boolean;
  readonly contact: boolean;
  /** Every button on the page in sentence case (the owner's label does not fit in capitals). */
  readonly sentence: boolean;
}

const PAGES = new WeakMap<RenderContext, BoldPage>();

/** The page model, worked out once per render. */
export function boldPage(ctx: RenderContext): BoldPage {
  const known = PAGES.get(ctx);
  if (known !== undefined) return known;
  const ids = ctx.sections.map((s) => s.id);
  const trustInHero = ids[0] === "hero" && ids[1] === "trust";
  const flow = trustInHero ? ids.filter((id) => id !== "trust") : ids;
  const contact = isVisible(ctx, "contact");
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
export function bandClass(ctx: RenderContext, id: SectionId): string {
  const { flow, surface } = boldPage(ctx);
  return `sec ${surface.get(id) ?? "paper"}${seamClass(flow, surface, id)}`;
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

/** The owner's call-to-action button, which leads to the contact form's heading. */
export function ctaButton(ctx: RenderContext, large = false): SafeHtml {
  return html`<a class="${buttonClass(ctx, "ghost", large)}" href="${fragment("quote")}">${ctx.doc.copy.ctaText}</a>`;
}

/**
 * The call bar's and the phone menu's second button: the short label. When the owner's full label holds it,
 * the full label is the accessible name, so the promise matches the form's heading (WCAG 2.5.3).
 */
export function shortCtaButton(ctx: RenderContext): SafeHtml {
  const cta = ctx.doc.copy.ctaText;
  const short = shortCta(cta);
  const named = short !== cta && cta.toLowerCase().includes(short.toLowerCase());
  return named
    ? html`<a class="${buttonClass(ctx, "ghost")}" href="${fragment("quote")}" aria-label="${cta}">${short}</a>`
    : html`<a class="${buttonClass(ctx, "ghost")}" href="${fragment("quote")}">${short}</a>`;
}

/**
 * The house heading: an eyebrow (a slanted bar and the section's menu label in small spaced capitals), the
 * h2 and the AI's intro when there is one.
 */
export function sectionHead(id: SectionId, eyebrow: string, title: string, intro?: string, extra: SafeHtml | false = false): SafeHtml {
  return html`<div class="sec-head"><p class="kicker eyebrow">${eyebrow}</p><h2 id="${DOM_ID[id]}-title" class="h2 display">${title}</h2>${intro && html`<p class="sec-intro">${intro}</p>`}${extra}</div>`;
}

/** A licence: its label, then its number as one unit ("Texas master plumber M-40123"). */
export function licenceMarkup(licence: Facts["licences"][number], labelClass = "lic-label", numberClass = "lic-num"): SafeHtml {
  const { label, number } = licenceParts(licence);
  if (label === "") return html`<span class="${numberClass}">${number}</span>`;
  return html`<span class="${labelClass}">${label}<span class="sr-only">:</span></span> <span class="${numberClass}">${number}</span>`;
}
