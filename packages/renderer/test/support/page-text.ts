// A page's text for the content checks that must hold in every design (A12 §8 and the A12-0 round-2
// rulings: count meaning, not markup). Tags, comments and <style>/<script> bodies are removed and
// entities stay escaped. All whitespace is dropped as well, so a phrase is found however a design splits
// it across elements: "From <span>$89</span>", "<small>From</small>$89" and
// "Texas master plumber<span class="sr-only">:</span> <span>M-40123</span>" all read as the owner wrote them.
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { startTags } from "./page-safety.ts";

/** The text of `markup` without tags, comments, <style>/<script> bodies or whitespace. */
export function squashedText(markup: string): string {
  let text = markup.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  for (const raw of new Set(startTags(text).map((tag) => tag.raw))) text = text.replaceAll(raw, "");
  return squash(text.replace(/<\/[a-zA-Z][\w-]*>/g, ""));
}

/** `phrase` without whitespace, to look up in squashedText(). */
export const squash = (phrase: string): string => phrase.replace(/\s+/g, "");

/** How often `phrase` appears in the text of `markup`. */
export const countInText = (markup: string, phrase: string): number => squashedText(markup).split(squash(phrase)).length - 1;

/** The attributes whose values a person sees (alt, a tooltip) or hears (an accessible name). */
const READ_ATTRIBUTES: ReadonlySet<string> = new Set(["alt", "title", "aria-label"]);

/** Elements whose content the page never shows. */
const UNREAD_ELEMENTS: ReadonlySet<string> = new Set(["script", "style"]);

/**
 * The texts a person reads or hears on the page, for the claims check (A12-0 round-4 rulings): each text
 * node and each alt, title and aria-label value, in page order, parsed and decoded as the browser does
 * (parse5 follows the HTML standard). Unlike squashedText() each text node stays apart, so
 * "<li>Licensed</li><li>Insured</li>" keeps its word boundaries. Comments, the doctype and <style>/<script>
 * bodies are not read. KNOWN LIMITS: a word split across elements ("b<span>onded</span>") and CSS content
 * text are not read; each design's sheet is locked and reviewed.
 */
export function readableTexts(markup: string): string[] {
  const texts: string[] = [];
  const read = (node: DefaultTreeAdapterMap["node"]): void => {
    if ("value" in node) texts.push(node.value);
    if ("attrs" in node) texts.push(...node.attrs.filter((a) => READ_ATTRIBUTES.has(a.name)).map((a) => a.value));
    if ("childNodes" in node && !UNREAD_ELEMENTS.has(node.nodeName)) node.childNodes.forEach(read);
  };
  read(parse(markup));
  return texts.filter((text) => text.trim() !== "");
}
