// What Classic decides once per page, from the sections that render: which band each section sits on,
// whether the credentials lift into the hero, which review the hero shows. Every section reads it.
import type { Facts, SectionId } from "@asksite/site-schema";
import { isVisible, type RenderContext } from "../../context.ts";

export type Band = "paper" | "white";

export interface Plan {
  /** The hero shows the owner's photo; otherwise the business card stands in for it. */
  readonly photo: boolean;
  /**
   * The Service area and Credentials sections render. The towns and hours show only while the first does,
   * and the hero's and contact band's credential lines only while the second does: an owner who hides a
   * section hides its facts (amendment A6), as on today's page.
   */
  readonly areaShown: boolean;
  readonly trustShown: boolean;
  /** The business card lists the hours, so the Service area section shows the owner's base instead. */
  readonly cardHours: boolean;
  /** The review the hero shows (never shown again below), or -1. */
  readonly heroQuote: number;
  /** The credentials come straight after the hero and become a card over its lower edge (from 60rem). */
  readonly lift: boolean;
  /** In a short desktop window the hero's ledger shows those facts in one row instead of the card. */
  readonly liftSwap: boolean;
  /** Light bands alternate over the sections that render; the contact band is always dark. */
  readonly band: Readonly<Partial<Record<SectionId, Band>>>;
  /** The section that ends with a Call-or-quote row (tablets and wider), if any. */
  readonly ctaAfter: SectionId | undefined;
}

/** The longest review the hero may show. */
export const HERO_QUOTE_MAX = 160;

/**
 * The hero's review: a short one that names a town, trying the reviews after the lead first (so the
 * Reviews section keeps its lead), then the lead, then a short one with no town. Only while the Reviews
 * section renders and keeps at least one other review; -1 otherwise.
 */
export function heroQuoteIndex(reviews: Facts["testimonials"]): number {
  if (reviews.length < 2) return -1;
  const order = [...reviews.keys()].slice(1).concat(0);
  const short = order.filter((i) => (reviews[i]?.quote.length ?? Infinity) <= HERO_QUOTE_MAX);
  return short.find((i) => reviews[i]?.location !== undefined) ?? short[0] ?? -1;
}

function makePlan(ctx: RenderContext): Plan {
  const { facts } = ctx.doc;
  const ids = ctx.sections.map((s) => s.id);
  const hero = ctx.sections.find((s) => s.id === "hero");
  const photo = hero?.variant === "photo" && facts.heroPhoto !== undefined;
  const liftFacts = facts.licences.length + (facts.insured ? 1 : 0) + (facts.freeEstimates ? 1 : 0);
  const lift = ids[1] === "trust" && liftFacts > 0;

  const band: Partial<Record<SectionId, Band>> = {};
  let previous: Band = "paper";
  for (const id of ids) {
    if (id === "hero" || id === "contact") continue;
    if (id === "trust" && lift) band[id] = "paper";
    else band[id] = previous = previous === "paper" ? "white" : "paper";
  }

  const after = (["testimonials", "gallery"] as const).find((id) => ids.includes(id));
  const areaShown = isVisible(ctx, "serviceArea");
  return {
    photo,
    areaShown,
    trustShown: isVisible(ctx, "trust"),
    cardHours: !photo && areaShown && facts.hours.length > 0,
    heroQuote: isVisible(ctx, "testimonials") ? heroQuoteIndex(facts.testimonials) : -1,
    lift,
    liftSwap: lift && liftFacts <= 4,
    band,
    ctaAfter: after !== undefined && ids[ids.indexOf(after) + 1] !== "contact" ? after : undefined,
  };
}

const plans = new WeakMap<RenderContext, Plan>();

/** The page's plan, made once per render (render() builds one context per page). */
export function plan(ctx: RenderContext): Plan {
  let found = plans.get(ctx);
  if (found === undefined) plans.set(ctx, (found = makePlan(ctx)));
  return found;
}

/** The section that renders right after `id`, if any. */
export function nextSection(ctx: RenderContext, id: SectionId): SectionId | undefined {
  return ctx.sections[ctx.sections.findIndex((s) => s.id === id) + 1]?.id;
}
