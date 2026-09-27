// Latin letters that look like A-Z letters although Unicode gives them no A-Z base letter, so no normalisation
// changes them ("ı", "ƒ", "Ł", capital iota "Ɩ", script g "ɡ", schwa "ə"), each with the A-Z letters a reader takes it
// for (A9b, A9e), and the click letters that look like punctuation (A9c). claims.ts reads copy through this table, so
// such a letter hides no claim word ("Łicensed" is "Licensed") and a click letter never joins two words ("ǀBondedǀ" is
// "|Bonded|"). It is for claim matching only: copy is never changed. Only the look-alikes listed here are read this way.
//
// Derived from Unicode 17.0 (the version Node uses) and Unicode's own data:
// - the moderator's list: ı ȷ ø ł đ ħ ŧ ƀ ƒ ß æ œ þ ð and their capitals, plus U+02BB ʻ and U+02BC ʼ
//   read as an apostrophe ("Hawaiʻi"). confusables.txt reads þ as p; the list reads it "th", as in "þe";
// - confusables.txt (UTS #39, Version 18.0.0 of 2026-08-06, Unicode License v3, notice in THIRD_PARTY_NOTICES.md,
//   https://www.unicode.org/Public/18.0.0/security/confusables.txt): every letter copy allows whose
//   prototype is A-Z letters once its marks are removed, read through the letters this table lists (A9e: ə, whose
//   prototype is ǝ, reads e). Its prototype "l" stands for both I and l, so the letters named for I read "I" (Ɩ capital
//   iota, Ɨ; ꟾ I longa, which has no case, reads "i", and since A9f "l" too); its prototype "rn" stands for both rn and m,
//   so ɱ and ᵯ, named for M, read "m". Like ASCII I and l, each of the others is read one way only;
// - UnicodeData.txt names of the form "LATIN ... LETTER X WITH ...": X with a hook, stroke, bar, curl or tail (A9e: X may
//   also be a letter this table lists, so ꬶ SCRIPT G WITH CROSSED-TAIL reads g, or two A-Z letters, as in ᵺ); and
//   (A9e) the letterform names SCRIPT, INSULAR, BLACKLETTER, BARRED, BROKEN, SIGMOID, OLD POLISH, LENIS, ARCHAIC and
//   GLOTTAL X, read as X (Ꝼ INSULAR F reads F, ꬳ BARRED E reads e), and XY DIGRAPH, read as XY (ʥ, ꭦ);
// - the other case of a listed letter, unless copy refuses it;
// - ĸ, which NamesList.txt cross-refers to U+1D0B small capital K;
// - A9c: Ɯ (turned M) read as W and Ǝ (reversed E) read as E, with ǝ, the other case of Ǝ; and the click letters
//   U+01C0-01C3 as the punctuation they look like (their Unicode 1.0 names are LATIN LETTER PIPE, DOUBLE PIPE,
//   PIPE DOUBLE BAR and EXCLAMATION MARK): ǀ "|" and ǁ "||" by those names (confusables.txt reads them as the letters l
//   and ll; A9c item 4 reads the click letters as punctuation instead, so "ǀicensed" is not "licensed", an accepted
//   residual), and ǃ "!" (its name and confusables.txt). ǂ has no confusables.txt entry and reads as no A-Z letter, so
//   it separates words as it is;
// - A9e: ɛ (open e) reads e (the moderator's A9e list; confusables.txt maps it to ꞓ, c with bar), and the saltillo ꞌ
//   and Ꞌ read as an apostrophe (the A9e list and confusables.txt); ʋ reads v like its capital Ʋ, and ꞵ reads b like its
//   capital Ꞵ (A9f: and each also reads the way confusables.txt reads it, u and ß; SECOND_READINGS below); and the
//   abbreviation letters ꝱ ꝲ ꝳ ꝴ ꝵ (DUM, LUM, MUM, NUM, RUM) read d, l, m, n and r, the letter each draws with a stroke
//   (Unicode 18.0 code chart);
// - A9f: ꟽ (epigraphic inverted M) reads w, ɘ (reversed e) e, ᴉ (turned i) i, ꟻ (epigraphic reversed F) f and ʊ
//   (upsilon) u: the moderator's A9f list of letters that draw like those A-Z letters in the six theme font stacks (the
//   A9e review's WebKit render), though confusables.txt gives them no A-Z prototype. By the rules above, Ʊ (the other case
//   of ʊ) reads U, and ᵿ (UPSILON WITH STROKE; confusables.txt: ʊ + U+0335) reads u;
// - A9f review round 1: ʗ (stretched c) reads c, ʘ (bilabial click, an O with a dot) o, Ꜧ and ꜧ (heng) H and h, and ɧ
//   (heng with hook) h: they too draw like those A-Z letters in the six theme font stacks (the A9f attack round's
//   Chromium and WebKit render), and confusables.txt gives them no prototype (NamesList.txt cross-refers Ꜧ to Ⱨ, which
//   reads H). By the name rule above, U+1DF0F (STRETCHED C WITH CURL) reads c.
// Not listed: other letters that look like no A-Z letter (turned, reversed, open and Greek-derived letters such as
// Ɔ, ɐ, ɹ, ʌ, Ʌ, Ʃ and Ʒ), and the look-alikes no rule above derives, such as ᴗ, ꞷ, ʃ and ʍ (accepted residuals, design
// §2.2), and ɞ, ʚ, ʬ and ɿ (weaker look-alikes the A9f attack round left to the moderator; recorded there too). Small
// capitals and the letters that look like a digit never reach the claim checker: copy refuses them (copy.ts).

/** What each look-alike reads as: A-Z letters (capitals as capitals, other letters as small letters) or punctuation. */
export const LOOKALIKES: Readonly<Record<string, string>> = {
  "'": "ʻʼꞋꞌ",
  "|": "ǀ",
  "||": "ǁ",
  "!": "ǃ",
  a: "ⱥɑᶏꞻꬰꭤ", A: "ȺⱭꞺ",
  aa: "ꜳ", AA: "Ꜳ",
  ae: "æ", AE: "Æ",
  ao: "ꜵ", AO: "Ꜵ",
  au: "ꜷ", AU: "Ꜷ",
  av: "ꜹꜻ", AV: "ꜸꜺ",
  ay: "ꜽ", AY: "Ꜽ",
  b: "ƀƃƅɓᵬᶀꞗꞵ", B: "ƁƂƄɃꞖꞴ",
  c: "ƈȼɕʗꞓꞔ𝼏𝼝", C: "ƇȻꞒꟄ",
  co: "ꭃꭄ",
  d: "ðđƌȡɖɗᵭᶁᶑꝱꝺꟈ𝼥", D: "ÐĐƉƊƋꝹꟇ",
  dz: "ʣʥꭦ",
  e: "ɇⱸǝəɘɚɛᶒᶓᶕꜫꬲꬳꬴ", E: "ɆƎƏƐꜪ",
  eo: "ᴔꭁꭂ",
  f: "ƒẝʄᵮᶂꝼꞙꟻꬵ", F: "ƑꝻꞘ",
  fn: "ʩ𝼀",
  g: "ƍǥɠɡᶃꞡꬶ", G: "ƓǤꝽꞠꞬ",
  h: "ħⱨɦɧꜧꞕ", H: "ĦⱧꜦꞪ",
  i: "ıɨɩᴉᵼᶖꞽꟾ𝼚", I: "ƖƗꞼ",
  j: "ȷɉɟʝ", J: "ɈꞲ",
  k: "ĸƙⱪᶄꝁꝃꝅꞣ", K: "ƘⱩꝀꝂꝄꞢ",
  l: "łƚȴⱡɫɬɭᶅꝇꝉꝲꞁꞎꬷꬸꬹ𝼑𝼓𝼦", L: "ŁȽⱠⱢꝆꝈꞭ",
  ll: "ỻ", LL: "Ỻ",
  ls: "ʪ",
  lz: "ʫ",
  m: "ɱᵯᶆꝳꟿꬺ", M: "Ɱ",
  n: "ŋƞȵɲɳᵰᶇꝴꞑꞥꬻꬼ𝼔𝼧", N: "ŊƝȠꞐꞤ",
  o: "øⱺɵʘᴑᴓꝋꝍꟁꬽꬾ𝼛", O: "ØƟꝊꝌꟀ",
  oe: "œ", OE: "Œ",
  oo: "ꝏ", OO: "Ꝏ",
  p: "ƥƿᵱᵽᶈꝑꝓꝕ", P: "ƤǷⱣꝐꝒꝔ",
  q: "ɋʠᶐꝗꝙ", Q: "ɊꝖꝘ",
  r: "ɍɼɽɾᵲᵳᶉꝵꞃꞧꭇꭈꭉꭊ𝼖𝼨", R: "ƦɌⱤꞂꞦ",
  rn: "ꭑ",
  s: "ȿʂᵴᶊꞅꞩꟊꟍꟙ𝼞𝼩", S: "ⱾꞄꞨꟅꟉꟌꟘ",
  ss: "ßꟗ", SS: "ẞꟖ",
  t: "ŧƫƭȶⱦʈᵵꞇ𝼉𝼪", T: "ŦƬƮȾꞆ",
  tc: "ʨ",
  tf: "ꝷ",
  th: "þᵺꝥꝧ", TH: "ÞꝤꝦ",
  ts: "ʦꭧ",
  u: "ʉʊᵿᶙꞟꞹꞿꭎꭏꭒ", U: "ɄƱꞞꞸꞾ",
  ue: "ᵫ",
  uo: "ꭣ",
  v: "ⱱⱴʋꝟ", V: "ƲꝞ",
  w: "ⱳɯɰꝡꟽ", W: "ⱲƜꝠ",
  x: "ᳵᶍꭓꭔꭕꭖꭗꭘꭙ", X: "Ꭓ",
  y: "ƴɏỿɣᶌꭚ", Y: "ƳɎỾƔ",
  z: "ƶȥɀⱬʐʑᵶᶎ", Z: "ƵȤⱫⱿꟆ",
};

/**
 * The look-alikes that read two ways (A9f), each under its second reading; the first is in LOOKALIKES. ʋ reads v like its
 * capital Ʋ and u as confusables.txt reads it; ꞵ reads b like its capital Ꞵ and ß ("ss") as confusables.txt reads it;
 * ꟾ (I longa) reads i as its name says and l as confusables.txt reads it. Their capitals read one way.
 */
export const SECOND_READINGS: Readonly<Record<string, string>> = { l: "ꟾ", ss: "ꞵ", u: "ʋ" };

const readAs = (table: Readonly<Record<string, string>>): ReadonlyMap<string, string> =>
  new Map(Object.entries(table).flatMap(([reading, letters]) => Array.from(letters, (letter): [string, string] => [letter, reading])));
const READ_AS = readAs(LOOKALIKES);
const SECOND_READ_AS = readAs(SECOND_READINGS);

/** Composed (NFC), so a precomposed letter stays as typed, with every combining mark removed that NFC leaves on its own. */
const composed = (text: string): string => text.normalize("NFC").replace(/\p{M}/gu, "");

/** Every look-alike read as what it looks like: its second way when it is in `secondWay`, else its first. */
const readLookalikes = (text: string, secondWay: ReadonlySet<string>): string =>
  text.replace(/[^\x00-\x7F]/gu, (character) => (secondWay.has(character) ? SECOND_READ_AS.get(character) : READ_AS.get(character)) ?? character);

/**
 * The text as a reader takes it, for claim matching (A9, A9b, A9c): composed (NFC), so a precomposed letter stays as
 * typed ("Saïd", "Tiệm Giặt Sấy"), with every combining mark removed that NFC leaves on its own (one that is not part
 * of a precomposed letter, such as U+0336 in "Licen" + U+0336 + "sed" or U+0307 on an i, which draws as a plain i),
 * and then with every look-alike listed above read its first way ("lıcensed", "ǀBondedǀ").
 */
export function foldLookalikes(text: string): string {
  return readLookalikes(composed(text), new Set());
}

/**
 * A9g: the look-alikes that also draw as punctuation or a symbol: ᴉ as "!", ʗ as "(", ʘ as "⊙" (its Unicode 1.0 name is
 * LATIN LETTER BULLSEYE) and Ʊ as "℧" (confusables.txt reads ℧ as Ʊ). Read only as a letter, one glued to a claim word
 * joins it ("ƒreeᴉ" reads "freei", while the page shows "free!"), so foldings() also reads them as a word break.
 */
const SYMBOL_LIKE = /[ᴉʗʘƱ]/gu;

/**
 * Every way a reader can take the text (A9f): foldLookalikes' reading first, then one reading for each combination of
 * the two-way letters in the text read their second way, each letter on its own, so "Fiʋe" (v) and "insʋred" (u) are
 * both found, and so is "ꟾnsʋred" (i and u). All the copies of one letter read the same way in one reading, so a two-way
 * letter used both ways inside one word ("ꟾꟾcensed") is not read (an accepted residual). A9g: when the text holds a
 * SYMBOL_LIKE letter, the same readings follow again with each of them as a space ("free "), so twice as many.
 */
export function foldings(text: string): string[] {
  const letters = composed(text);
  const broken = letters.replace(SYMBOL_LIKE, " ");
  return broken === letters ? readingsOf(letters) : [...readingsOf(letters), ...readingsOf(broken)];
}

/** One reading for each combination of the two-way letters in `letters` read their second way (A9f). */
function readingsOf(letters: string): string[] {
  const twoWay = [...SECOND_READ_AS.keys()].filter((letter) => letters.includes(letter));
  return Array.from({ length: 2 ** twoWay.length }, (_, combination) =>
    readLookalikes(letters, new Set(twoWay.filter((_, bit) => combination & (1 << bit)))),
  );
}
