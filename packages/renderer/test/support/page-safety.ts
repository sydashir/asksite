// Page-wide safety checks, run on every page of every fixture in every design (A12, A16; moved from xss.test.ts).
// A design's markup is ours, but the owner's facts and the AI's copy fill it, so each page is checked as the HTML
// tokenizer reads it.
import { PAGE_IDS, PAGES } from "@asksite/site-schema";

// Elements a page may hold. dl dt dd strong small wbr and the svg shapes were added for the page
// designs (A12-0 round-2 rulings); the attribute, URL and handler checks below apply to every element.
const ALLOWED_TAGS = new Set(
  (
    "html head meta title link style script body a header div nav ul li details summary span main section " +
    "p h1 h2 h3 img figure figcaption blockquote hr table tbody tr th td address br form label input select option " +
    "textarea button aside footer dl dt dd strong small wbr " +
    "svg g path rect circle line polyline polygon"
  ).split(" "),
);

// The links a page may hold, one anchored pattern: an absolute https://, tel: or mailto: URL ("https:x" is a relative path), a fragment of this page,
// or exactly one of the site's own page paths (built from PAGES), optionally with a fragment: "/services", "/contact#quote".
const PAGE_PATHS = PAGE_IDS.map((id) => PAGES[id].path.replace(/[/.]/g, "\\$&")).join("|");
const ALLOWED_URL = new RegExp(String.raw`^(?:(?:https://|tel:|mailto:|#)|(?:${PAGE_PATHS})(?:#[a-z][a-z0-9-]*)?$)`);

// Attributes the browser fetches or navigates to.
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster", "cite", "data", "ping", "background", "xlink:href", "srcset"]);

// Attributes that carry CSS or a whole document, or change how the page is read: never in our pages.
const FORBIDDEN_ATTRIBUTES = new Set(["style", "srcdoc", "http-equiv"]);

// Start tags and attributes as the HTML tokenizer reads them: attribute values may be
// double-quoted, single-quoted or unquoted. Our templates only write double quotes, so any
// other form can only come from a payload that escaped escaping.
const ATTRIBUTE_SOURCE = String.raw`\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\x60]+))?`;
const START_TAG = new RegExp(String.raw`<([a-zA-Z][\w-]*)((?:${ATTRIBUTE_SOURCE})*)\s*\/?>`, "g");
const ATTRIBUTE = /\s+([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export interface Attribute {
  readonly name: string;
  readonly value: string;
  /** False when the value was single-quoted or unquoted. */
  readonly doubleQuoted: boolean;
}

export interface StartTag {
  readonly name: string;
  readonly attributes: readonly Attribute[];
  readonly raw: string;
  /** Where the tag starts in the page. */
  readonly index: number;
}

export function startTags(page: string): StartTag[] {
  return [...page.matchAll(START_TAG)].map((m) => ({
    name: (m[1] ?? "").toLowerCase(),
    attributes: [...(m[2] ?? "").matchAll(ATTRIBUTE)].map((a) => ({
      name: (a[1] ?? "").toLowerCase(),
      value: a[2] ?? a[3] ?? a[4] ?? "",
      doubleQuoted: a[3] === undefined && a[4] === undefined,
    })),
    raw: m[0],
    index: m.index,
  }));
}

/**
 * Everything on the page that could run script, fetch or navigate somewhere it should not; [] when safe. The one
 * <link> a page may hold is its canonical, rel and href only, with an https: href; `canonical`, when given, is the
 * href it must have.
 */
export function pageSafetyProblems(page: string, canonical?: string): string[] {
  const problems: string[] = [];
  const tags = startTags(page);
  const endTags = page.match(/<\/[a-zA-Z][\w-]*>/g) ?? [];
  const doctypes = page.match(/<!DOCTYPE html>/g) ?? [];
  const comments = page.match(/<!--/g) ?? [];
  if (comments.length !== 1) problems.push(`${comments.length} comments`);
  const opens = (page.match(/</g) ?? []).length;
  if (opens !== tags.length + endTags.length + doctypes.length + comments.length) problems.push('a raw "<" that starts none of our tags');
  for (const tag of tags) {
    if (!ALLOWED_TAGS.has(tag.name)) problems.push(`element ${tag.name}`);
    for (const { name, value, doubleQuoted } of tag.attributes) {
      if (name.startsWith("on")) problems.push(`handler ${name}`);
      if (FORBIDDEN_ATTRIBUTES.has(name)) problems.push(`attribute ${name}`);
      if (!doubleQuoted) problems.push(`unquoted ${name}`);
      if (URL_ATTRIBUTES.has(name) && !ALLOWED_URL.test(value)) problems.push(`url ${name}=${value}`);
      if (/^\s*(javascript|vbscript|data):/i.test(value)) problems.push(`scheme ${name}=${value}`);
    }
  }
  const links = tags.filter((t) => t.name === "link");
  if (links.length !== 1) problems.push(`${links.length} <link> elements`);
  for (const link of links) {
    const names = link.attributes.map((a) => a.name).sort();
    const rel = link.attributes.find((a) => a.name === "rel")?.value;
    const href = link.attributes.find((a) => a.name === "href")?.value ?? "";
    if (names.join() !== "href,rel" || rel !== "canonical" || !href.startsWith("https:")) problems.push(`link ${link.raw}`);
    else if (canonical !== undefined && href !== canonical) problems.push(`canonical ${href}, expected ${canonical}`);
  }
  const scripts = tags.filter((t) => t.name === "script");
  for (const script of scripts) if (script.raw !== '<script type="application/ld+json">') problems.push(`script ${script.raw}`);
  if (scripts.length > 2) problems.push(`${scripts.length} scripts`);
  const styles = tags.filter((t) => t.name === "style").length;
  if (styles !== 2) problems.push(`${styles} style blocks`);
  return problems;
}
