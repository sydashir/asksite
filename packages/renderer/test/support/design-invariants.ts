// What every page design must keep from today's site (A12 §7 and the moderator addendum, H1; A16): other
// code and tests rely on it (Plan 4's editor matches `<section id="…"`, the focus-outside rule needs the
// call bar to be the only <aside>, the contact form posts these exact fields, every link must lead somewhere).
// A design is free in everything else. Each check compares a design's site with today's site (BASELINE) for the
// same document, page by page.
import { NEEDS_A_FACT, NEVER_IN_COPY, PAGES, QUOTE_HREF, unbackedClaims, type Facts, type PageId, type SiteDocument } from "@asksite/site-schema";
import type { Design } from "../../src/design.ts";
import type { RenderedSite } from "../../src/render.ts";
import { CLOSING_BAND_ID, DOM_ID, SERVICES_PREVIEW_ID } from "../../src/sections/ids.ts";
import { sitePages } from "../../src/visibility.ts";
import { startTags } from "./page-safety.ts";
import { readableTexts } from "./page-text.ts";

/** page.slice from the first `from` to the end of the first `to` after it; "" when either is missing. */
function between(page: string, from: string, to: string): string {
  const start = page.indexOf(from);
  const end = start === -1 ? -1 : page.indexOf(to, start);
  return end === -1 ? "" : page.slice(start, end + to.length);
}

/**
 * The <form>…</form> markup with every class attribute removed: fields, names, labels, limits, "Send
 * request", and the honeypot (its wrapper's aria-hidden, the field's tabindex="-1" and autocomplete="off").
 * A design may restyle all of it, the honeypot wrapper included; the per-design e2e checks prove the
 * honeypot stays wholly off-screen and out of the tab order (A12-0 round-2 rulings).
 */
export const formSkeleton = (page: string): string => between(page, "<form", "</form>").replace(/\sclass="[^"]*"/g, "");

const idsOf = (page: string) => startTags(page).flatMap((t) => t.attributes.filter((a) => a.name === "id").map((a) => a.value));

/** The element id of every section, and of the two blocks render.ts adds (DOM_ID's values, the services preview, the closing band). */
const SECTION_DOM_IDS: readonly string[] = [...Object.values(DOM_ID), SERVICES_PREVIEW_ID, CLOSING_BAND_ID];

/** Every href on the page that is not an absolute https:, tel: or mailto: URL, in page order. */
const internalHrefs = (page: string): string[] =>
  startTags(page).flatMap((t) => t.attributes.filter((a) => a.name === "href" && !/^(https:|tel:|mailto:)/.test(a.value)).map((a) => a.value));

/**
 * Each internal link that leads nowhere, once, in page order: "#frag" must be an id on this page ("#" alone leads to
 * the top of the page, HTML "select the indicated part"), "/path" a page the site renders, "/path#frag" an id on that
 * page. A design must not link a section or a page the site leaves out (hidden by the owner, amendment A6, or
 * without content). `site` maps each rendered path to the ids on that page.
 */
function deadLinks(page: string, site: ReadonlyMap<string, readonly string[]>): string[] {
  const own = new Set(idsOf(page));
  const dead = internalHrefs(page).filter((href) => {
    if (href === "#") return false;
    if (href.startsWith("#")) return !own.has(href.slice(1));
    const [path = "", fragmentId] = href.split("#") as [string, string | undefined];
    const ids = site.get(path);
    return !href.startsWith("/") || ids === undefined || (fragmentId !== undefined && !ids.includes(fragmentId));
  });
  return [...new Set(dead)];
}

/** Every internal link of every page of `site` that leads nowhere, as "path: href": the no-throw test's check that no owner's site holds a dead link. */
export function deadLinksOf(site: RenderedSite): string[] {
  const ids = new Map(site.pages.map((p) => [p.path, idsOf(p.html)]));
  return site.pages.flatMap((p) => deadLinks(p.html, ids).map((href) => `${p.path}: ${href}`));
}

/** One link of the navigation labelled "Main": where it goes, what it says and whether it is marked as the current page. */
export interface NavLink {
  readonly href: string;
  readonly label: string;
  readonly current: boolean;
}

/** The anchors of the navigation labelled "Main", in page order (a phone menu repeats them). The <nav> is found by its aria-label attribute, whatever the attribute order. */
export function navAnchors(page: string): NavLink[] {
  const nav = startTags(page).find((t) => t.name === "nav" && t.attributes.some((a) => a.name === "aria-label" && a.value === "Main"));
  if (nav === undefined) return [];
  const end = page.indexOf("</nav>", nav.index);
  const markup = page.slice(nav.index, end === -1 ? page.length : end);
  return startTags(markup)
    .filter((t) => t.name === "a")
    .map((t) => {
      const text = markup.slice(t.index + t.raw.length, markup.indexOf("</a>", t.index)).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      const attr = (name: string) => t.attributes.find((x) => x.name === name)?.value;
      return { href: attr("href") ?? "", label: text, current: attr("aria-current") === "page" };
    });
}

/** The Main navigation's links as "href label", in page order. */
export const navLinks = (page: string): string[] => navAnchors(page).map((l) => `${l.href} ${l.label}`);

/**
 * True when every item of `wanted` is in `list` and keeps `wanted`'s order, other items allowed between and around.
 * A phone menu repeats the desktop list, so the order is judged on each item's first place (the first list) and on
 * its last (the last list): swapping two links in either list breaks one of them.
 */
function inOrder(wanted: readonly string[], list: readonly string[]): boolean {
  const places = (find: (item: string) => number) => wanted.map(find);
  const increasing = (indexes: readonly number[]) => indexes.every((at, i) => at !== -1 && (i === 0 || at > (indexes[i - 1] ?? -1)));
  return increasing(places((item) => list.indexOf(item))) && increasing(places((item) => list.lastIndexOf(item)));
}

const faqDetails = (page: string) =>
  startTags(page).filter((t) => t.name === "details" && t.attributes.some((a) => a.name === "name" && a.value === "faq")).length;

const jsonLd = (page: string) => [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The claims a page design's own text is checked for (A12-0 round-4 rulings): every NEEDS_A_FACT pattern
 * (licence, insurance, emergency and round-the-clock hours, the full week, free) and NEVER_IN_COPY's bond,
 * rating, guarantee and price patterns. NEVER_IN_COPY's other patterns guard AI copy only: a design's
 * decorative curly quote, a quoted caption, review words, years or weekdays state no credential.
 */
export const CREDENTIAL_CLAIMS: readonly RegExp[] = [
  ...NEVER_IN_COPY.filter((pattern) => ["bonded", "certified", "guaranteed", "cheapest"].some((word) => pattern.test(word))),
  ...NEEDS_A_FACT.map((claim) => claim.pattern),
];

/**
 * "24/7": NEEDS_A_FACT's round-the-clock claim ("around the clock", "day or night", "anytime") in digits,
 * backed by the same fact. site-schema's lists leave it out because copy may hold no digit at all; a
 * design's own text can hold it, and the approved mockups show a "24/7" pill to owners with that fact.
 */
export const ROUND_THE_CLOCK = { pattern: /\b24\s*\/\s*7\b/, backedBy: (facts: Facts): boolean => facts.emergency247 } as const;

// The joiners of claims.ts: hyphen, space, figure dash, en dash, em dash and minus sign.
const JOIN = String.raw`[-\u2012\u2013\u2014\u2212 ]`;

/**
 * A star rating, in symbols or digits: "★★★★★", "5-star", "4.9 stars", "5 out of 5 stars". No owner fact backs
 * one (Plan 1 decision 7: no star ratings); CREDENTIAL_CLAIMS holds the word forms ("five-star", "rated").
 * site-schema's word lists leave these forms out because copy may hold no digit, but a design's own text can
 * hold them (A12-0 round-5 rulings, review4 I-1).
 */
export const STAR_RATING = new RegExp(String.raw`[\u2605\u2606\u2B50\u272A-\u2730]|\b\d+(?:\.\d+)?\s*(?:${JOIN}\s*)?(?:out\s+of\s+\d+\s+)?stars?\b`, "i");

/**
 * 24-hour, same-day and next-day service, in digits or words: "Open 24 hours", "24-hour service", "Same-day
 * service". Today's page states "Open 24 hours" only from the owner's own opening hours (A12-0 round-5 rulings,
 * review4 I-1).
 */
export const SERVICE_HOURS = new RegExp(String.raw`\b24${JOIN}?(?:hours?|hrs?)\b|\b(?:same|next)${JOIN}day\b`, "i");

/** A text as the page shows it (amendment A2): a run of whitespace as one space, and U+2010/U+2011 as "-". */
const asShownOnPage = (text: string): string => text.replace(/\s+/g, " ").replace(/[\u2010\u2011]/g, "-");

/** Every match of `pattern` in `text`, in order. */
const allMatches = (pattern: RegExp, text: string): string[] => [...text.matchAll(new RegExp(pattern, "gi"))].map((match) => match[0]);

/**
 * The credential claims `page` states that the owner's `facts` do not back, lower-cased, each once, in every text
 * a person reads or hears, read as the page shows it: site-schema's unbackedClaims, each word it finds cut down
 * to the unbacked credential claim it holds; an unbacked "24/7"; and every star rating and 24-hour, same-day or
 * next-day service claim. So a quoted phrase or a web address around a claim counts as that claim, and one
 * around a backed claim counts as nothing.
 * unbackedClaims gives the first word of each pattern in a text, so a text that holds two words of one of its
 * patterns shows the first. invariantProblems then drops every claim today's page for the same document states
 * too, such as an owner's pasted review or the owner's own "Open 24 hours".
 * KNOWN LIMIT: a star row drawn only as SVG shapes, with no text or label, has no text to read; each build's
 * review and its judges see the page.
 */
export function pageClaims(page: string, facts: Facts): string[] {
  const texts = [...new Set(readableTexts(page).map(asShownOnPage))];
  const unbacked = CREDENTIAL_CLAIMS.filter((pattern) => !NEEDS_A_FACT.some((claim) => claim.pattern === pattern && claim.backedBy(facts)));
  const words = texts.flatMap((text) => unbackedClaims(text, facts)).flatMap((word) => unbacked.flatMap((pattern) => pattern.exec(word)?.[0] ?? []));
  const digits = ROUND_THE_CLOCK.backedBy(facts) ? [] : texts.flatMap((text) => ROUND_THE_CLOCK.pattern.exec(text)?.[0] ?? []);
  const ratingsAndHours = texts.flatMap((text) => [STAR_RATING, SERVICE_HOURS].flatMap((pattern) => allMatches(pattern, text)));
  return [...new Set([...words, ...digits, ...ratingsAndHours].map((claim) => claim.toLowerCase()))];
}

const titleOf = (page: string) => /<title>([^<]*)<\/title>/.exec(page)?.[1];
const descriptionOf = (page: string) => /<meta name="description" content="([^"]*)">/.exec(page)?.[1];
const canonicalOf = (page: string) => /<link rel="canonical" href="([^"]*)">/.exec(page)?.[1];

/** The ids of the <section> blocks a page must hold, in order: the page's sections, Home's services preview right before testimonials (after its last section without them), and the closing band on every page but Contact. */
export function expectedSectionIds(doc: SiteDocument, pageId: PageId): string[] {
  const page = sitePages(doc).find((p) => p.id === pageId);
  if (page === undefined) return [];
  const ids = page.sections.flatMap((s) => [...(pageId === "home" && s.id === "testimonials" ? [SERVICES_PREVIEW_ID] : []), DOM_ID[s.id]]);
  if (pageId === "home" && !ids.includes(DOM_ID.testimonials)) ids.push(SERVICES_PREVIEW_ID);
  if (pageId !== "contact") ids.push(CLOSING_BAND_ID);
  return ids;
}

/** The headings of the page, as levels, in page order. */
const headingLevels = (page: string): number[] => startTags(page).flatMap((t) => (/^h[1-6]$/.test(t.name) ? [Number(t.name.slice(1))] : []));

/**
 * Every shared invariant one page (`path`, drawn by `design` for `doc`) breaks, compared with today's page at the same
 * path; [] when it keeps them all. `site` is the design's own site (the ids on each page, for the links), `todays` the
 * claims today's whole site states (the owner's own words, such as a review, or hours).
 */
export function pageProblems(
  page: string,
  baseline: string,
  path: string,
  doc: SiteDocument,
  design: Design,
  site: ReadonlyMap<string, readonly string[]>,
  todays: readonly string[],
): string[] {
  const problems: string[] = [];
  const pageId = (Object.keys(PAGES) as PageId[]).find((id) => PAGES[id].path === path);
  if (pageId === undefined) return [`path ${path} is no page`];
  if (!page.includes(`<body data-design="${doc.theme.design}" `)) problems.push("<body> does not name the design");

  const comments = page.match(/<!--/g) ?? [];
  if (comments.length !== 1 || !page.includes(design.attribution)) problems.push("the one comment is not the design's attribution");

  // H1: each section opens with exactly `<section id="<DOM id>"`, in this page's order.
  const sections = startTags(page).filter((t) => t.name === "section").map((t) => /^<section id="([^"]*)"/.exec(t.raw)?.[1] ?? t.raw);
  const expected = expectedSectionIds(doc, pageId);
  if (!same(sections, expected)) problems.push(`sections ${JSON.stringify(sections)}, expected ${JSON.stringify(expected)}`);

  // The phone call bar is the page's only <aside> (the focus-outside rule depends on it); it calls and asks for a quote.
  const asides = startTags(page).filter((t) => t.name === "aside");
  if (asides.length !== 1) problems.push(`${asides.length} <aside> elements`);
  const bar = between(page, "<aside", "</aside>");
  const barTag = asides[0];
  const barClass = barTag?.attributes.find((a) => a.name === "class")?.value.split(/\s+/) ?? [];
  if (!barTag?.attributes.some((a) => a.name === "aria-label" && a.value === "Call us")) problems.push('the <aside> is not labelled "Call us"');
  if (!barClass.includes("focus-outside:static")) problems.push("the call bar lacks focus-outside:static");
  if (!bar.includes(`href="tel:${doc.facts.phone}"`)) problems.push("the call bar does not call the business");
  if (!bar.includes(`href="${QUOTE_HREF}"`)) problems.push("the call bar does not link to the quote form");

  // The form is on the Contact page only, and equals today's there (classes aside), its id="quote" included.
  const forms = startTags(page).filter((t) => t.name === "form").length;
  if (pageId === "contact" ? formSkeleton(page) !== formSkeleton(baseline) : forms > 0) {
    problems.push(pageId === "contact" ? "the contact form differs from today's (classes aside)" : `${forms} <form> elements outside the Contact page`);
  }

  const ids = idsOf(page);
  const baselineIds = idsOf(baseline);
  if (new Set(ids).size !== ids.length) problems.push("duplicate ids");
  const kept = ids.filter((id) => baselineIds.includes(id));
  if (!same(kept, baselineIds)) problems.push(`ids ${JSON.stringify(kept)}, expected ${JSON.stringify(baselineIds)}`);
  // A section this page does not hold (on another page, hidden by the owner, amendment A6, or without content)
  // leaves no element with its id behind, so no link can reach it either.
  const leftOut = ids.filter((id) => SECTION_DOM_IDS.includes(id) && !expected.includes(id));
  if (leftOut.length > 0) problems.push(`left-out sections keep ids ${JSON.stringify(leftOut)}`);
  const dead = deadLinks(page, site);
  if (dead.length > 0) problems.push(`links to nowhere ${JSON.stringify(dead)}`);

  // Every "Get a quote" link is exactly the form on the Contact page.
  const quotes = [...new Set(internalHrefs(page).filter((href) => href.includes("#quote")))];
  if (!same(quotes, quotes.length === 0 ? [] : [QUOTE_HREF])) problems.push(`quote links ${JSON.stringify(quotes)}, expected only ${QUOTE_HREF}`);

  // Today's page links (href and label) stay in the Main nav, in today's order, and only this page's own link is marked
  // as the current page. A design may add links (a menu toggle, a call link); the link checks above, ids, axe and the
  // e2e menu test cover those.
  const todaysLinks = [...new Set(navLinks(baseline))];
  if (!inOrder(todaysLinks, navLinks(page))) problems.push(`navigation ${JSON.stringify(navLinks(page))} lacks, in order, ${JSON.stringify(todaysLinks)}`);
  const marked = [...new Set(navAnchors(page).filter((l) => l.current).map((l) => l.href))];
  const unmarked = navAnchors(page).filter((l) => l.href === path && !l.current);
  if (!same(marked, [path]) || unmarked.length > 0) problems.push(`aria-current on ${JSON.stringify(marked)}, expected on every link to ${path} and no other`);

  // One <h1> on every page, in the first section of an inner page; no heading level is skipped (axe heading-order).
  const h1s = startTags(page).filter((t) => t.name === "h1");
  const firstSection = startTags(page).find((t) => t.name === "section");
  const firstEnd = firstSection === undefined ? -1 : page.indexOf("</section>", firstSection.index);
  if (h1s.length !== 1) problems.push(`${h1s.length} <h1> elements`);
  else if (pageId !== "home" && (firstSection === undefined || h1s[0]!.index < firstSection.index || h1s[0]!.index > firstEnd)) problems.push("the <h1> is not in the page's first section");
  const levels = headingLevels(page);
  const jump = levels.findIndex((level, i) => level > (levels[i - 1] ?? 0) + 1);
  if (jump !== -1) problems.push(`heading level jumps to h${levels[jump]} after h${levels[jump - 1] ?? 0}`);

  if (faqDetails(page) !== faqDetails(baseline)) problems.push(`${faqDetails(page)} details[name=faq], expected ${faqDetails(baseline)}`);
  if (!same(jsonLd(page), jsonLd(baseline))) problems.push("JSON-LD differs from today's");
  for (const [what, value, wanted] of [
    ["title", titleOf(page), titleOf(baseline)],
    ["description", descriptionOf(page), descriptionOf(baseline)],
    ["canonical", canonicalOf(page), canonicalOf(baseline)],
  ] as const) {
    if (value !== wanted) problems.push(`${what} ${JSON.stringify(value)}, expected ${JSON.stringify(wanted)}`);
  }

  // The honesty rule (design §2.2; Plan 1 decisions 5 and 7): no credential claim the owner's facts do not
  // back, beyond those today's site shows for the same document (on any page), which come from the owner's own
  // words, such as a review, or hours (A12-0 round-4 and round-5 rulings; A16: a claim may sit on another page of
  // today's site, since each page shows a part of it).
  const added = pageClaims(page, doc.facts).filter((claim) => !todays.includes(claim));
  if (added.length > 0) problems.push(`unbacked claims ${JSON.stringify(added)}`);
  return problems;
}

/** Every shared invariant `site` (drawn by `design` for `doc`) breaks, compared with today's site (BASELINE) for the same document, as "path: problem"; [] when it keeps them all. */
export function invariantProblems(site: RenderedSite, baseline: RenderedSite, doc: SiteDocument, design: Design): string[] {
  const paths = site.pages.map((p) => p.path);
  const wanted = baseline.pages.map((p) => p.path);
  if (!same(paths, wanted)) return [`pages ${JSON.stringify(paths)}, expected ${JSON.stringify(wanted)}`];
  const ids = new Map(site.pages.map((p) => [p.path, idsOf(p.html)]));
  const todays = [...new Set(baseline.pages.flatMap((p) => pageClaims(p.html, doc.facts)))];
  return site.pages.flatMap((p, i) => pageProblems(p.html, baseline.pages[i]!.html, p.path, doc, design, ids, todays).map((problem) => `${p.path}: ${problem}`));
}

/** A design's custom properties must be named --aw-<design id>-* and hold plain CSS values: nothing that ends the rule, the <style> or fetches. */
export function variableProblems(designId: string, variables: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  const name = new RegExp(`^--aw-${designId}-[a-z0-9]+(?:-[a-z0-9]+)*$`);
  for (const [key, value] of Object.entries(variables)) {
    if (!name.test(key)) problems.push(`name ${key}`);
    if (/[;{}<>\\]|url\(|https?:/i.test(value)) problems.push(`value of ${key}`);
  }
  return problems;
}
