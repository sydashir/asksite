// What every page design must keep from today's page (A12 §7 and the moderator addendum, H1): other
// code and tests rely on it (Plan 4's editor matches `<section id="…"`, the focus-outside rule needs the
// call bar to be the only <aside>, the contact form posts these exact fields). A design is free in
// everything else. Each check compares a design's page with today's page (BASELINE) for the same document.
import type { SiteDocument } from "@asksite/site-schema";
import type { Design } from "../../src/design.ts";
import { DOM_ID } from "../../src/sections/ids.ts";
import { visibleSections } from "../../src/visibility.ts";
import { startTags } from "./page-safety.ts";

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

/**
 * Each in-page link (href="#…") whose target id is not on the page, once, in page order. A design must
 * not link a section the page leaves out: one the owner hid (amendment A6) or one without content.
 * href="#" is never dead: an empty fragment leads to the top of the page (HTML, "select the indicated part").
 */
function deadLinks(page: string): string[] {
  const ids = new Set(idsOf(page));
  const hrefs = startTags(page).flatMap((t) => t.attributes.filter((a) => a.name === "href" && a.value.startsWith("#")).map((a) => a.value));
  return [...new Set(hrefs.filter((href) => href !== "#" && !ids.has(href.slice(1))))];
}

/** The element id of every section (DOM_ID's values). */
const SECTION_DOM_IDS: readonly string[] = Object.values(DOM_ID);

/**
 * The links of the navigation labelled "Main" as "href label", in page order (a phone menu repeats
 * them). The <nav> is found by its aria-label attribute, whatever the attribute order.
 */
export function navLinks(page: string): string[] {
  const nav = startTags(page).find((t) => t.name === "nav" && t.attributes.some((a) => a.name === "aria-label" && a.value === "Main"));
  if (nav === undefined) return [];
  const end = page.indexOf("</nav>", nav.index);
  const markup = page.slice(nav.index, end === -1 ? page.length : end);
  return [...markup.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map(
    (m) => `${m[1]} ${(m[2] ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()}`,
  );
}

/** True when `wanted` appears in `list` in the same order, other items allowed between and around. */
function inOrder(wanted: readonly string[], list: readonly string[]): boolean {
  let next = 0;
  for (const item of list) if (item === wanted[next]) next++;
  return next === wanted.length;
}

const faqDetails = (page: string) =>
  startTags(page).filter((t) => t.name === "details" && t.attributes.some((a) => a.name === "name" && a.value === "faq")).length;

const jsonLd = (page: string) => [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Every shared invariant `page` (drawn by `design` for `doc`) breaks, compared with today's page; [] when it keeps them all. */
export function invariantProblems(page: string, baseline: string, doc: SiteDocument, design: Design): string[] {
  const problems: string[] = [];
  if (!page.includes(`<body data-design="${doc.theme.design}" `)) problems.push("<body> does not name the design");

  const comments = page.match(/<!--/g) ?? [];
  if (comments.length !== 1 || !page.includes(design.attribution)) problems.push("the one comment is not the design's attribution");

  // H1: each visible section opens with exactly `<section id="<DOM id>"`, in layout order.
  const sections = startTags(page).filter((t) => t.name === "section").map((t) => /^<section id="([^"]*)"/.exec(t.raw)?.[1] ?? t.raw);
  const expected = visibleSections(doc).map((s) => DOM_ID[s.id]);
  if (!same(sections, expected)) problems.push(`sections ${JSON.stringify(sections)}, expected ${JSON.stringify(expected)}`);

  // The phone call bar is the page's only <aside> (the focus-outside rule depends on it).
  const asides = startTags(page).filter((t) => t.name === "aside");
  if (asides.length !== 1) problems.push(`${asides.length} <aside> elements`);
  const bar = between(page, "<aside", "</aside>");
  const barTag = asides[0];
  const barClass = barTag?.attributes.find((a) => a.name === "class")?.value.split(/\s+/) ?? [];
  if (!barTag?.attributes.some((a) => a.name === "aria-label" && a.value === "Call us")) problems.push('the <aside> is not labelled "Call us"');
  if (!barClass.includes("focus-outside:static")) problems.push("the call bar lacks focus-outside:static");
  if (!bar.includes(`href="tel:${doc.facts.phone}"`)) problems.push("the call bar does not call the business");

  if (formSkeleton(page) !== formSkeleton(baseline)) problems.push("the contact form differs from today's (classes aside)");

  const ids = idsOf(page);
  const baselineIds = idsOf(baseline);
  if (new Set(ids).size !== ids.length) problems.push("duplicate ids");
  const kept = ids.filter((id) => baselineIds.includes(id));
  if (!same(kept, baselineIds)) problems.push(`ids ${JSON.stringify(kept)}, expected ${JSON.stringify(baselineIds)}`);
  // A section the page leaves out (hidden by the owner, amendment A6, or without content) leaves no
  // element with its id behind, so no link can reach it either.
  const leftOut = ids.filter((id) => SECTION_DOM_IDS.includes(id) && !expected.includes(id));
  if (leftOut.length > 0) problems.push(`left-out sections keep ids ${JSON.stringify(leftOut)}`);
  const dead = deadLinks(page);
  if (dead.length > 0) problems.push(`in-page links to missing ids ${JSON.stringify(dead)}`);

  // Today's section links (href and label) stay in the Main nav, in today's order. A design may add
  // links (a menu toggle, a call link); the in-page link check above, ids, axe and the e2e menu test cover those.
  const todaysLinks = [...new Set(navLinks(baseline))];
  if (!inOrder(todaysLinks, navLinks(page))) problems.push(`navigation ${JSON.stringify(navLinks(page))} lacks, in order, ${JSON.stringify(todaysLinks)}`);
  if (faqDetails(page) !== faqDetails(baseline)) problems.push(`${faqDetails(page)} details[name=faq], expected ${faqDetails(baseline)}`);
  if (!same(jsonLd(page), jsonLd(baseline))) problems.push("JSON-LD differs from today's");
  return problems;
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
