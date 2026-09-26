// The Unicode version the letter tables were derived from (A9c, A9d): NON_ENGLISH_LETTER and DIGIT_LETTER (copy.ts),
// LOOKALIKES (lookalikes.ts) and the SMALL_CAPITALS and DIGIT_LETTERS lists in copy.test.ts. A regular expression answers
// \p{...} from the engine's own Unicode data, so a Node, workerd or browser upgrade can change what copy accepts.
// copy.test.ts asks these questions in Node, and unicode.workerd.test.ts asks them inside workerd, where production runs.
//
// U+A7CE LATIN CAPITAL LETTER PHARYNGEAL VOICED FRICATIVE is new in Unicode 17.0 and U+1DF40 LATIN CAPITAL LETTER BARRED A
// is new in 18.0 (DerivedAge-18.0.0.txt lines 2076 and 2162). When an answer changes, derive those tables again from the
// new Unicode data.

/** The answers on Unicode 17.0. */
export const UNICODE_17 = {
  "U+A7CE is a letter (new in 17.0)": true,
  "U+1DF40 is unassigned (new in 18.0)": true,
} as const;

/** The same questions, answered by the running engine. */
export function unicodeVersion(): Record<keyof typeof UNICODE_17, boolean> {
  return {
    "U+A7CE is a letter (new in 17.0)": /^\p{L}$/u.test("\uA7CE"),
    "U+1DF40 is unassigned (new in 18.0)": /^\p{Cn}$/u.test("\u{1DF40}"),
  };
}
