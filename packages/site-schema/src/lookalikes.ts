// Latin letters that look like A-Z letters although Unicode gives them no A-Z base letter, so NFD leaves
// them whole ("ı", "ƒ", "Ł", capital iota "Ɩ"), each with the A-Z letters a reader takes it for (A9b).
// claims.ts reads copy through this table, so such a letter hides no claim word ("Łicensed" is
// "Licensed"). It is for claim matching only: copy is never changed.
//
// Derived from Unicode 17.0 (the version Node uses) and Unicode's own data:
// - the moderator's list: ı ȷ ø ł đ ħ ŧ ƀ ƒ ß æ œ þ ð and their capitals, plus U+02BB ʻ and U+02BC ʼ
//   read as an apostrophe ("Hawaiʻi"). confusables.txt reads þ as p; the list reads it "th", as in "þe";
// - confusables.txt (UTS #39, Version 18.0.0 of 2026-08-06, Unicode License v3,
//   https://www.unicode.org/Public/security/latest/confusables.txt): every letter copy allows whose
//   prototype is A-Z letters once its marks are removed. Its prototype "l" stands for both I and l, so the
//   letters named for I (Ɩ capital iota, Ɨ) read "I" and ǀ reads "l". Like ASCII I and l, each is read
//   one way only;
// - UnicodeData.txt names of the form "LATIN ... LETTER X WITH ...": X with a hook, stroke, bar, curl or tail;
// - the other case of a listed letter, unless confusables.txt says it looks like something else
//   (Ƽ, the capital of ƽ, looks like the digit 5);
// - ĸ, which NamesList.txt cross-refers to U+1D0B small capital K.
// Not listed: letters that look like no A-Z letter (turned, reversed, open and Greek-derived letters such
// as Ǝ, Ɔ, Ɛ, Ʃ and Ʒ). Letters of IPA Extensions, the Phonetic Extensions and Latin Extended-D never
// reach the claim checker: copy refuses them (copy.ts).

/** The A-Z letters (or apostrophe) each look-alike reads as: capitals as capitals, other letters as small letters. */
export const LOOKALIKES: Readonly<Record<string, string>> = {
  "'": "ʻʼ",
  a: "ⱥꭤ", A: "Ⱥ",
  ae: "æ", AE: "Æ",
  b: "ƀƃƅ", B: "ƁƂƄɃ",
  c: "ƈȼ\u{1DF1D}", C: "ƇȻ",
  co: "ꭃꭄ",
  d: "ðđƌȡ\u{1DF25}", D: "ÐĐƉƊƋ",
  e: "ɇⱸꬲꬴ", E: "Ɇ",
  f: "ƒẝꬵ", F: "Ƒ",
  g: "ƍǥ", G: "ƓǤ",
  h: "ħⱨ", H: "ĦⱧ",
  i: "ı\u{1DF1A}", I: "ƖƗ",
  j: "ȷɉ", J: "Ɉ",
  k: "ĸƙⱪ", K: "ƘⱩ",
  l: "łƚǀȴⱡꬷꬸꬹ\u{1DF11}\u{1DF13}\u{1DF26}", L: "ŁȽⱠⱢ",
  ll: "ǁỻ", LL: "Ỻ",
  m: "ꬺ", M: "Ɱ",
  n: "ŋƞȵꬻ\u{1DF27}", N: "ŊƝȠ",
  o: "øⱺꬽꬾ\u{1DF1B}", O: "ØƟ",
  oe: "œ", OE: "Œ",
  p: "ƥƿ", P: "ƤǷⱣ",
  q: "ɋ", Q: "Ɋ",
  r: "ɍꭇꭈꭉ\u{1DF16}\u{1DF28}", R: "ƦɌⱤ",
  rn: "ꭑ",
  s: "ƽȿ\u{1DF1E}\u{1DF29}", S: "Ȿ",
  ss: "ß", SS: "ẞ",
  t: "ŧƫƭȶⱦ\u{1DF09}\u{1DF2A}", T: "ŦƬƮȾ",
  th: "þ", TH: "Þ",
  u: "ꭎꭒ", U: "Ʉ",
  uo: "ꭣ",
  v: "ⱱⱴ", V: "Ʋ",
  w: "ⱳ", W: "Ⱳ",
  x: "ᳵꭖꭗꭘꭙ",
  y: "ƴɏỿꭚ", Y: "ƳɎỾ",
  z: "ƶȥɀⱬ", Z: "ƵȤⱫⱿ",
};

const READ_AS: ReadonlyMap<string, string> = new Map(
  Object.entries(LOOKALIKES).flatMap(([ascii, letters]) => Array.from(letters, (letter): [string, string] => [letter, ascii])),
);

/**
 * The text as a reader takes it, for claim matching (A9, A9b): in canonical decomposition (NFD) with every
 * combining mark (\p{M}) removed, so an accent or a mark never hides a letter ("lícensed", or "Award" + " " +
 * U+0336 + "winning"), and then with every look-alike letter read as its A-Z letters ("lıcensed").
 */
export function foldLookalikes(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\x00-\x7F]/gu, (character) => READ_AS.get(character) ?? character);
}
