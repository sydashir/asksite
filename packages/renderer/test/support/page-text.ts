// A page's text for the content checks that must hold in every design (A12 §8 and the A12-0 round-2
// rulings: count meaning, not markup). Tags, comments and <style>/<script> bodies are removed and
// entities stay escaped. All whitespace is dropped as well, so a phrase is found however a design splits
// it across elements: "From <span>$89</span>", "<small>From</small>$89" and
// "Texas master plumber<span class="sr-only">:</span> <span>M-40123</span>" all read as the owner wrote them.
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
