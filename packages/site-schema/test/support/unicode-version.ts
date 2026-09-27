// The Unicode version the letter tables were derived from (A9c, A9d): SMALL_CAPITAL and DIGIT_LETTER (copy.ts), LOOKALIKES
// and SECOND_READINGS (lookalikes.ts) and the SMALL_CAPITALS and DIGIT_LETTERS lists in copy.test.ts. A regular
// expression answers \p{...} from the engine's own Unicode data, so a Node, workerd or browser upgrade can change what
// copy accepts.
// copy.test.ts asks these questions in Node, and unicode.workerd.test.ts asks them inside workerd, where production runs.
//
// U+A7CE LATIN CAPITAL LETTER PHARYNGEAL VOICED FRICATIVE is new in Unicode 17.0 and U+1DF40 LATIN CAPITAL LETTER BARRED A
// is new in 18.0 (DerivedAge-18.0.0.txt lines 2076 and 2162). When an answer changes, derive those tables again from the
// new Unicode data.
//
// So package.json's engines range is "^24.13.1 || >=25.5.0": the Node versions on ICU 78.2 or later, which is Unicode 17.0.
// Node 24.13.1 is the first Node 24 on it (nodejs CHANGELOG_V24.md, 24.13.1: "deps: update icu to 78.2"; 24.13.0 has ICU
// 77.1, Unicode 16.0, and fails the tripwire), and 25.5.0 the first Node 25 (CHANGELOG_V25.md line 644, 25.5.0 of
// 2026-01-26: "deps: update icu to 78.2", the only ICU update in that changelog; v25.4.0 measured ICU 77.1 and fails the
// tripwire too, A9e).

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
