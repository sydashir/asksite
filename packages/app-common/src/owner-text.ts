// One line break form: CRLF and a lone CR, vertical tab, form feed, next line (U+0085), and the line and paragraph
// separators U+2028 and U+2029. Mirrors LINE_BREAK in apps/sites/src/lead.ts (apps/admin cannot import apps/sites).
const LINE_BREAK = /\r\n?|[\v\f\u0085\u2028\u2029]/g;
// Control characters other than "\n", and invisible formatting characters (e.g. U+202E, which can make text read backwards
// in the owner's inbox). U+200D stays so emoji survive. Mirrors HIDDEN in apps/sites/src/lead.ts.
const HIDDEN = /(?!\n)\p{Cc}|(?!\u200D)\p{Cf}/gu;

/**
 * Text an admin typed that reaches an owner (a rejection note, a takedown message), cleaned the way the sites Worker's
 * readLead cleans a multi-line lead message (clean(value, true)): every line break becomes "\n", a tab a space (so no
 * words are glued together), hidden characters go, then trim. Never longer than its input. "" means nothing is left.
 */
export function cleanOwnerText(text: string): string {
  return text.replace(LINE_BREAK, "\n").replaceAll("\t", " ").replace(HIDDEN, "").trim();
}
