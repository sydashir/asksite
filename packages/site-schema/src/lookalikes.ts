// Latin letters that look like A-Z letters although Unicode gives them no A-Z base letter, so no normalisation
// changes them ("ı", "ƒ", "Ł", capital iota "Ɩ"), each with the A-Z letters a reader takes it for (A9b), and the
// click letters that look like punctuation (A9c). claims.ts reads copy through this table, so such a letter hides
// no claim word ("Łicensed" is "Licensed") and a click letter never joins two words ("ǀBondedǀ" is "|Bonded|"). It
// is for claim matching only: copy is never changed. Only the look-alikes listed here are read this way.
//
// Derived from Unicode 17.0 (the version Node uses) and Unicode's own data:
// - the moderator's list: ı ȷ ø ł đ ħ ŧ ƀ ƒ ß æ œ þ ð and their capitals, plus U+02BB ʻ and U+02BC ʼ
//   read as an apostrophe ("Hawaiʻi"). confusables.txt reads þ as p; the list reads it "th", as in "þe";
// - confusables.txt (UTS #39, Version 18.0.0 of 2026-08-06, Unicode License v3, notice in THIRD_PARTY_NOTICES.md,
//   https://www.unicode.org/Public/18.0.0/security/confusables.txt): every letter copy allows whose
//   prototype is A-Z letters once its marks are removed. Its prototype "l" stands for both I and l, so the
//   letters named for I (Ɩ capital iota, Ɨ) read "I". Like ASCII I and l, each is read one way only;
// - UnicodeData.txt names of the form "LATIN ... LETTER X WITH ...": X with a hook, stroke, bar, curl or tail;
// - the other case of a listed letter, unless copy refuses it (Ƽ, the capital of ƽ, looks like the digit 5);
// - ĸ, which NamesList.txt cross-refers to U+1D0B small capital K;
// - A9c: Ɯ (turned M) read as W and Ǝ (reversed E) read as E, with ǝ, the other case of Ǝ; and the click letters
//   U+01C0-01C3 as the punctuation they look like (their Unicode 1.0 names are LATIN LETTER PIPE, DOUBLE PIPE,
//   PIPE DOUBLE BAR and EXCLAMATION MARK): ǀ "|", ǁ "||" and ǃ "!" (confusables.txt). ǂ has no confusables.txt
//   entry and reads as no A-Z letter, so it separates words as it is.
// Not listed: other letters that look like no A-Z letter (turned, reversed, open and Greek-derived letters such as
// Ɔ, Ɛ, Ʌ, Ʃ and Ʒ). Letters of IPA Extensions (except ʔ), the Phonetic Extensions and Latin Extended-D, -E and -G
// never reach the claim checker: copy refuses them (copy.ts).

/** What each look-alike reads as: A-Z letters (capitals as capitals, other letters as small letters) or punctuation. */
export const LOOKALIKES: Readonly<Record<string, string>> = {
  "'": "ʻʼ",
  "|": "ǀ",
  "||": "ǁ",
  "!": "ǃ",
  a: "ⱥ", A: "Ⱥ",
  ae: "æ", AE: "Æ",
  b: "ƀƃƅ", B: "ƁƂƄɃ",
  c: "ƈȼ", C: "ƇȻ",
  d: "ðđƌȡ", D: "ÐĐƉƊƋ",
  e: "ɇⱸǝ", E: "ɆƎ",
  f: "ƒẝ", F: "Ƒ",
  g: "ƍǥ", G: "ƓǤ",
  h: "ħⱨ", H: "ĦⱧ",
  i: "ı", I: "ƖƗ",
  j: "ȷɉ", J: "Ɉ",
  k: "ĸƙⱪ", K: "ƘⱩ",
  l: "łƚȴⱡ", L: "ŁȽⱠⱢ",
  ll: "ỻ", LL: "Ỻ",
  M: "Ɱ",
  n: "ŋƞȵ", N: "ŊƝȠ",
  o: "øⱺ", O: "ØƟ",
  oe: "œ", OE: "Œ",
  p: "ƥƿ", P: "ƤǷⱣ",
  q: "ɋ", Q: "Ɋ",
  r: "ɍ", R: "ƦɌⱤ",
  s: "ƽȿ", S: "Ȿ",
  ss: "ß", SS: "ẞ",
  t: "ŧƫƭȶⱦ", T: "ŦƬƮȾ",
  th: "þ", TH: "Þ",
  U: "Ʉ",
  v: "ⱱⱴ", V: "Ʋ",
  w: "ⱳ", W: "ⱲƜ",
  x: "ᳵ",
  y: "ƴɏỿ", Y: "ƳɎỾ",
  z: "ƶȥɀⱬ", Z: "ƵȤⱫⱿ",
};

const READ_AS: ReadonlyMap<string, string> = new Map(
  Object.entries(LOOKALIKES).flatMap(([reading, letters]) => Array.from(letters, (letter): [string, string] => [letter, reading])),
);

/**
 * The text as a reader takes it, for claim matching (A9, A9b, A9c): composed (NFC), so a precomposed letter stays as
 * typed ("Saïd", "Tiệm Giặt Sấy"), with every combining mark removed that NFC leaves on its own (one that is not part
 * of a precomposed letter, such as U+0336 in "Licen" + U+0336 + "sed" or U+0307 on an i, which draws as a plain i),
 * and then with every look-alike listed above read as what it looks like ("lıcensed", "ǀBondedǀ").
 */
export function foldLookalikes(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\p{M}/gu, "")
    .replace(/[^\x00-\x7F]/gu, (character) => READ_AS.get(character) ?? character);
}
