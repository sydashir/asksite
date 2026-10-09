// What Classic decides once per page, from the blocks the page draws (its sections in the owner's order, Home's
// services preview, the closing band): which band each block sits on, whether the credentials lift into the hero,
// which review the hero shows, which facts other pages hold, and whether the page ends on a dark band. Every block
// reads it.
import type { Facts, SectionId } from "@asksite/site-schema";
import { onPage, onSite, type RenderContext } from "../../context.ts";
import { scopeLine, shownArea } from "../../format.ts";

export type Band = "paper" | "white";

/** A block of the page's <main>: a section, or one of the two blocks render.ts adds (A16). */
export type Block = SectionId | "preview" | "closing";

export interface Plan {
  /** The hero shows the owner's photo; otherwise the business card stands in for it. */
  readonly photo: boolean;
  /**
   * The Service area and Credentials sections render, on any page of the site. The towns and hours show only while
   * the first does, and the hero's and contact band's credential lines only while the second does: an owner who
   * hides a section hides its facts (amendment A6), as on today's site.
   */
  readonly areaShown: boolean;
  readonly trustShown: boolean;
  /**
   * One town (or the whole country or the world), no area note and no hours: the approved mockup folds the Service
   * area section away. The shared contract keeps the section, so it is one short line at the foot of the contact band;
   * never when it opens the page.
   */
  readonly areaFold: boolean;
  /** Home's business card lists the hours (no hero photo). */
  readonly cardHours: boolean;
  /** The review the hero shows (never shown again below), or -1. */
  readonly heroQuote: number;
  /** The credentials come straight after the hero and become a card over its lower edge (from 60rem). */
  readonly lift: boolean;
  /** In a short desktop window the hero's ledger shows those facts in one row instead of the card. */
  readonly liftSwap: boolean;
  /** Light bands alternate over the light blocks, the closing band's included (its dark panel sits on one); the contact band is dark. */
  readonly band: Readonly<Partial<Record<Block, Band>>>;
  /** The page's last section: the closing band comes right after it (on every page but Contact). */
  readonly last: SectionId | undefined;
  /** The page ends on a dark band (Contact's contact band, or its one-line Service area folded into it): the footer opens with a rule. */
  readonly endsDark: boolean;
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

/** The page's blocks in render.ts's order: the services preview right before the reviews (last without them) on Home, the closing band last but on Contact. */
function blocks(ctx: RenderContext): Block[] {
  const home = ctx.page.id === "home";
  const order: Block[] = ctx.page.sections.flatMap((s): Block[] => (home && s.id === "testimonials" ? ["preview", s.id] : [s.id]));
  if (home && !order.includes("preview")) order.push("preview");
  if (ctx.page.id !== "contact") order.push("closing");
  return order;
}

function makePlan(ctx: RenderContext): Plan {
  const { facts } = ctx.doc;
  const ids = ctx.page.sections.map((s) => s.id);
  const hero = ctx.page.sections.find((s) => s.id === "hero");
  const photo = hero?.variant === "photo" && facts.heroPhoto !== undefined;
  const liftFacts = facts.licences.length + (facts.insured ? 1 : 0) + (facts.freeEstimates ? 1 : 0);
  const lift = hero !== undefined && ids[1] === "trust" && liftFacts > 0;

  // Home's first light band follows the paper hero; an inner page opens on paper, under the paper header.
  const band: Partial<Record<Block, Band>> = {};
  let previous: Band = hero !== undefined ? "paper" : "white";
  for (const id of blocks(ctx)) {
    if (id === "hero" || id === "contact") continue;
    if (id === "trust" && lift) band[id] = "paper";
    else band[id] = previous = previous === "paper" ? "white" : "paper";
  }

  const areaShown = onSite(ctx, "serviceArea");
  const { places, note } = shownArea(facts);
  const oneLine = places.length === 1 || scopeLine(facts) !== undefined;
  const areaFold = onPage(ctx, "serviceArea") && ids[0] !== "serviceArea" && oneLine && note === undefined && facts.hours.length === 0;
  return {
    photo,
    areaShown,
    trustShown: onSite(ctx, "trust"),
    areaFold,
    cardHours: hero !== undefined && !photo && areaShown && facts.hours.length > 0,
    heroQuote: onPage(ctx, "testimonials") ? heroQuoteIndex(facts.testimonials) : -1,
    lift,
    liftSwap: lift && liftFacts <= 4,
    band,
    last: ctx.page.id === "contact" ? undefined : ids.at(-1),
    endsDark: ctx.page.id === "contact" && (ids.at(-1) === "contact" || areaFold),
  };
}

const plans = new WeakMap<RenderContext, Plan>();

/** The page's plan, made once per page (render() builds one context per page). */
export function plan(ctx: RenderContext): Plan {
  let found = plans.get(ctx);
  if (found === undefined) plans.set(ctx, (found = makePlan(ctx)));
  return found;
}

/** The band class of a light block: "bw" on white, "bp" on paper. */
export const bandClass = (ctx: RenderContext, block: Block): "bw" | "bp" => (plan(ctx).band[block] === "white" ? "bw" : "bp");
