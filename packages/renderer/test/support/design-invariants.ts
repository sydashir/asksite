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

/** The <form>…</form> markup with every class attribute removed: fields, names, labels, limits, "Send request". */
export const formSkeleton = (page: string): string => between(page, "<form", "</form>").replace(/\sclass="[^"]*"/g, "");

/** The element around the honeypot field, classes included: they keep it off-screen. */
export function honeypot(page: string): string {
  const field = page.indexOf('id="contact-website"');
  if (field === -1) return "";
  return page.slice(page.lastIndexOf("<div", field), page.indexOf("</div>", field) + "</div>".length);
}

const idsOf = (page: string) => startTags(page).flatMap((t) => t.attributes.filter((a) => a.name === "id").map((a) => a.value));

/** The header navigation's links as "href label", once each, in order. */
export function navLinks(page: string): string[] {
  const nav = between(page, '<nav aria-label="Main"', "</nav>");
  const links = [...nav.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => `${m[1]} ${(m[2] ?? "").replace(/<[^>]*>/g, "").trim()}`);
  return [...new Set(links)];
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
  if (honeypot(page) === "" || honeypot(page) !== honeypot(baseline)) problems.push("the honeypot differs from today's");

  const ids = idsOf(page);
  const baselineIds = idsOf(baseline);
  if (new Set(ids).size !== ids.length) problems.push("duplicate ids");
  const kept = ids.filter((id) => baselineIds.includes(id));
  if (!same(kept, baselineIds)) problems.push(`ids ${JSON.stringify(kept)}, expected ${JSON.stringify(baselineIds)}`);

  if (!same(navLinks(page), navLinks(baseline))) problems.push(`navigation ${JSON.stringify(navLinks(page))}, expected ${JSON.stringify(navLinks(baseline))}`);
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
