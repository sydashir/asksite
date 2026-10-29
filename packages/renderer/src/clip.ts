// Moved verbatim out of render.ts so the cart markup (shop/cart-markup.ts) can clip a title without importing the designs.
import { escapeText } from "./escape.ts";

// Search results truncate long titles. Measured on the escaped text ("&" counts as "&amp;"),
// which is how html-validate's long-title rule counts, so this is never more lenient.
export const MAX_TITLE_LENGTH = 70;

export const fitsTitle = (title: string) => escapeText(title).length <= MAX_TITLE_LENGTH;

// Built on first use, not at load: the owner app's preview imports the renderer, and importing must work everywhere.
// clipText needs Intl.Segmenter (floor: Chrome 87, Firefox 125, Safari 14.1).
let graphemes: Intl.Segmenter | undefined;

/**
 * `raw` itself when `fits` accepts it; otherwise its longest prefix, cut at a word boundary (else where a word starts or ends, else at a grapheme
 * boundary, so no emoji or accent is split), with "…" appended, that `fits` accepts. Clips the RAW text: escaping is
 * left to the html template, so an escape sequence is never cut in half.
 */
export function clipText(raw: string, fits: (text: string) => boolean): string {
  if (fits(raw)) return raw;
  graphemes ??= new Intl.Segmenter("en", { granularity: "grapheme" });
  const cuts = [...graphemes.segment(raw)].map((part) => part.index);
  const longest = cuts.findLast((cut) => fits(`${raw.slice(0, cut)}…`));
  if (longest === undefined) return "…";
  const wordEnd =
    cuts.findLast((cut) => cut > 0 && cut <= longest && /\s/.test(raw.charAt(cut)) && raw.slice(0, cut).trim() !== "") ??
    // No whitespace to cut at (a run of comma-joined words): cut where a word starts or ends, so no word is left half-written ("sincere" -> "since").
    cuts.findLast((cut) => cut > 0 && cut <= longest && /\w/.test(raw.charAt(cut - 1)) !== /\w/.test(raw.charAt(cut)));
  return `${raw.slice(0, wordEnd ?? longest).trimEnd()}…`;
}
