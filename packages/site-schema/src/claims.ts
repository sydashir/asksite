import type { Copy } from "./copy.ts";
import { DAYS, type Facts } from "./facts.ts";
import { foldings } from "./lookalikes.ts";

// Claim checker for AI copy. Credentials, insurance, time in business, hours, prices, reviews
// and contact details are owner facts that the renderer shows from `facts`. Copy may mention a
// claim only when the owner's facts back it, and never mentions a claim no fact can back.
// Word lists catch the usual phrasings, not every paraphrase: plan 4's approval screen still
// shows the owner every sentence before a page is published.
//
// The words of a multi-word claim may be joined by a hyphen, a space, or a dash character: figure
// dash (U+2012), en dash (U+2013), em dash (U+2014) or minus sign (U+2212), so "award-winning"
// and "award" + U+2013 + "winning" read the same way. asReadOnPage below reads every other dash
// as an em dash (A8c) but does NOT fold en/em dash to a hyphen (A2: they usually separate two
// clauses, not join one compound word), so this class is spelled out wherever a pattern below
// joins two words.
//
// Claims are matched on the page read as typed and folded (A9, A9b, A9c, A9f, A9g), and a claim any reading finds counts.
// The typed reading runs first (A9c item 1 said "folded, then as typed"; the order only decides which spelling of a found
// word is shown, recorded by A9e):
// - as typed, as before A9, so every claim the checker found before A9 is still found;
// - folded (foldings in lookalikes.ts): composed (NFC), with every combining mark removed that is not part
//   of a precomposed letter, the look-alikes listed in lookalikes.ts read as the A-Z letters they look like, and
//   the click letters read as punctuation. A letter that reads two ways (A9f: ʋ as v or u, ꞵ as b or ß, ꟾ as i or l;
//   A9g: Ʋ as V or U) is read both ways, so there is one folded reading for each combination of the two-way letters in
//   the text. So an overlay mark inside a word or between two words ("Licen" +
//   U+0336 + "sed", "Award" + " " + U+0336 + "winning"), a look-alike letter ("lıcensed", "ƒree", "ŁICENSED")
//   or a click letter ("ǀCertifiedǀ", where "ǀ" looks like "|") on its own hides no claim. The fold alone would join two
//   words the page shows apart ("Top" + U+0336 + "rated"), so the typed reading stays: the fold only ever adds a claim.
//   A9g: ᴉ, ʗ, ʘ and Ʊ also draw as "!", "(", "⊙" and "℧", so when the text holds one, every folded reading is made
//   again with each of them as a word break ("Estimates are ƒreeᴉ" reads "free!" on the page and is a claim).
// - each of those again with "_" and the glued symbol separators (GLUED_SEPARATORS below) read as a space (readings below): "_" is a
//   word character, so "Fully _insured" or "Award__winning" hid the claim word from every rule that needs a word boundary
//   while the page shows it, and a symbol between the words of a multi-word claim ("Award·winning", "Same•day") hid it
//   from the patterns that join the words with a hyphen or a space.
// A CamelCase word is read as typed, as before A9: A9d dropped A9c's CamelCase reading, which refused real names
// that run a claim word into another word ("McMillion Creek", "FreeFlow Plumbing", "StreakFree Window Cleaning").
// Small capitals and letters that look like digits ("ɪnsured", "ᴄertified", "Ƨ", "ꜭ") never get here: Copy refuses
// them. Other phonetic letters do (A9e), and lookalikes.ts lists the look-alikes among them ("ɡuaranteed", "licənsəd").
// Accepted residuals (the approval screen is the backstop; each passes at main too; design §2.2 lists them with
// examples): a precomposed accented letter is read as typed, so a deliberately accented claim word ("lícensed", "frée")
// is not caught (A9c), as before A9; a letter the table reads another way ("cheaþest", þ is "th"; "Ɩicensed", Ɩ is "I")
// or does not list (turned, reversed and open letters such as "Ʌ", "ɐ", "ɒ" and "ɹ": "FrɅe", "ɹated", and other
// look-alikes no rule derives: "insᴗred", "ꞷarranty", "ʃree", "ʍillions"), or a symbol ("fr℮℮", "L¡censed",
// "days∕week", "INS℧RED"); a two-way letter used both ways inside one claim word ("ꟾꟾcensed", A9f: one reading reads
// every copy of a letter the same way; since A9g copy refuses ꟾ); a letter the table reads that draws as a letter,
// glued to a claim word that has a look-alike ("Fully ɘlıcensed", "Our ʊƀonded crew": the page shows an extra letter,
// like ASCII "xlicensed"; A9g); one of ᴉ ʗ ʘ Ʊ read as a letter inside a claim word while another is glued to it
// ("Our ʗertifiedᴉ pros", A9g); a combining Latin small letter used as a letter ("Lic" + U+0364 + "nsed"); ASCII
// "l" or "|" for "I" and a click letter for "l" ("CERTlFlED", "ǀicensed"); an overlay mark inside a claim word together
// with a look-alike glued to its end ("Bon" + U+0336 + "dedł"), which neither reading finds; a claim word run into
// another word in CamelCase ("TopRated", "WeAreBonded"; A9d); a separator symbol with a space on either side
// ("Award · winning", "Award ·winning"), which reads as a list, not one claim (M3); and the phrasings the word lists do not cover.
// The other way round, the folded reading finds claim words in some words of other languages, which main accepts
// ("frɛɛ", "saɣ", Middle English "Þursday"): copy is English marketing text, so A9f accepts these as residuals too.

/** Claims no owner fact backs: rejected in copy whatever the facts say. */
export const NEVER_IN_COPY: readonly RegExp[] = [
  /\bbond(s|ed)?\b/i, // California B&P Code 7071.13 forbids mentioning the contractor bond in advertising
  /\b(certified|accredited|award[-\u2012\u2013\u2014\u2212 ]winning|top[-\u2012\u2013\u2014\u2212 ]rated|five[-\u2012\u2013\u2014\u2212 ]star|rated|ratings?|bbb)\b/i,
  /\b(reviews?|says?|said)\b|[“”„«»‘]/i, // real reviews are owner facts; no quotes invented in copy
  // (’ is left out: it doubles as the apostrophe, as in "don’t").
  // A phrase in straight quotes: an opening " directly followed by a letter, then a closing ".
  // A lone " or one that closes and reopens an HTML attribute (" onfocus="…) quotes nobody; the
  // renderer escapes it like any other character.
  /"[a-z][^"]*"/i,
  /\b(guarantee[ds]?|warrant(y|ies|ied))\b/i,
  /\b(cheapest|lowest|dollars?|bucks|cents)\b/i,
  /\b((twen|thir|for|fif|six|seven|eigh|nine)ty|hundreds?|thousands?|millions?)\b/i, // spelled-out numbers
  /\b(since|years?|decades?|established|founded|generations?)\b/i, // time in business comes from yearFounded
  /\b(same[-\u2012\u2013\u2014\u2212 ]day|next[-\u2012\u2013\u2014\u2212 ]day|weekends?|(mon|tues|wednes|thurs|fri|satur|sun)days?)\b/i, // hours are facts
  /\b[a-z0-9-]+\.(com|net|org|us|biz|info|co|io)\b/i, // bare web addresses
];

/** True when the owner's opening hours cover all seven days. */
const opensEveryDay = (facts: Facts): boolean => DAYS.every((day) => facts.hours.some((entry) => entry.days.includes(day)));

/** Claims allowed only when the owner's facts back them. */
export const NEEDS_A_FACT: ReadonlyArray<{ readonly pattern: RegExp; readonly backedBy: (facts: Facts) => boolean }> = [
  { pattern: /\blicen[cs]\w*/i, backedBy: (facts) => facts.licences.length > 0 },
  { pattern: /\binsur\w*/i, backedBy: (facts) => facts.insured },
  {
    pattern: /\b(emergenc\w*|a?round[-\u2012\u2013\u2014\u2212 ]the[-\u2012\u2013\u2014\u2212 ]clock|day[-\u2012\u2013\u2014\u2212 ]or[-\u2012\u2013\u2014\u2212 ]night|any[-\u2012\u2013\u2014\u2212 ]?time)\b/i,
    backedBy: (facts) => facts.emergency247,
  },
  {
    // The full-week phrase, backed by 24/7 service or by opening hours on every day (A8c): "seven days
    // a/per/each/every week", "seven days of the week" and "seven days/week". Not caught (known):
    // "seven-day service", which reads the same as "seven-day turnaround", and "open seven days",
    // which reads the same as "keep the vents open seven days" (A8c-2). Refused without those facts
    // even when it says how often, not when ("water the sod seven days a week"): the owner sees the
    // message and rephrases.
    pattern:
      /\bseven[-\u2012\u2013\u2014\u2212 ]days?([-\u2012\u2013\u2014\u2212 ](a|per|each|every)[-\u2012\u2013\u2014\u2212 ]|[-\u2012\u2013\u2014\u2212 ]of[-\u2012\u2013\u2014\u2212 ]the[-\u2012\u2013\u2014\u2212 ]| ?\/ ?)week\b/i,
    backedBy: (facts) => facts.emergency247 || opensEveryDay(facts),
  },
  { pattern: /(?<![\w-])free\b|\bno[-\u2012\u2013\u2014\u2212 ](charge|cost)\b|\bcomplimentary\b/i, backedBy: (facts) => facts.freeEstimates },
];

/**
 * The invisible characters copy.ts lets through: U+034F COMBINING GRAPHEME JOINER and the
 * variation selectors U+FE00-U+FE0F and U+E0100-U+E01EF (default-ignorable, Script=Inherited, not
 * \p{Cc}/\p{Cf}). Inside a word one splits it while the page still shows the whole word
 * ("Licen\u034Fsed" reads "Licensed"). They are all combining marks, which the claim and link
 * checks remove (A9), but an invisible character has no honest use in copy, so document.ts still
 * rejects copy that contains any of them. The one exception is U+FE0E/U+FE0F directly after an
 * emoji, which picks the emoji's text or colour form (✔ then U+FE0F). After NFKC the only emoji
 * that are letters or digits are the digits 0-9, which copy bans, so an allowed selector never
 * sits inside a word.
 */
export const HIDDEN_IN_COPY = /(?![\uFE0E\uFE0F])\p{Default_Ignorable_Code_Point}|(?<!\p{Emoji})[\uFE0E\uFE0F]/u;

/**
 * Every other dash reads as an em dash (A8c): any \p{Pd} except the hyphens and the dashes the joiner
 * class already lists, plus seven dash-like characters that are not \p{Pd} (U+2043 HYPHEN BULLET,
 * U+23AF, U+2500, U+2501, U+30FC, U+FF70 and, A9f, U+A7F7 LATIN EPIGRAPHIC LETTER SIDEWAYS I, a letter
 * that draws as a dash, which confusables.txt reads as U+30FC through an em dash; since A9g copy refuses it, and the
 * reading stays, harmless). So "Award" + U+2015 + "winning" joins like "Award" + U+2014 + "winning", and a free after
 * one of them is a free offer, as after an em dash.
 */
const OTHER_DASH = /(?![-\u2010-\u2014])[\p{Pd}\u2043\u23AF\u2500\u2501\u30FC\uFF70\uA7F7]/gu;

// HTML shows a run of whitespace as one space and U+2010/U+2011 look like "-" (en/em dashes do not).
export const asReadOnPage = (text: string): string =>
  text.replace(/\s+/g, " ").replace(/[\u2010\u2011]/g, "-").replace(OTHER_DASH, "\u2014");

/**
 * "_" (U+005F LOW LINE) is read as a space in every position: it is a word character, so it hid a claim word from every
 * word-boundary rule ("Fully _insured" must still be caught), and no list uses it as a separator.
 */
const UNDERSCORE = /_/g;

/**
 * The symbols a reader reads as a word break between the words of a claim when GLUED between two non-space characters
 * ("Award·winning"), each of which copy.ts lets through:
 * "\u00B7" (U+00B7 MIDDLE DOT: the dot that separates items, "Award·winning crew"),
 * "\u2022" (U+2022 BULLET: the list bullet, "Same•day service"),
 * "~" (U+007E TILDE: drawn as a dash-like joiner, "Award~winning"),
 * "*" (U+002A ASTERISK: a star or bullet in a list, "Award*winning"),
 * "|" (U+007C VERTICAL LINE: the bar between items, "Award|winning"),
 * "\u2219" (U+2219 BULLET OPERATOR: draws like the middle dot, "Award∙winning"),
 * "\u30FB" (U+30FB KATAKANA MIDDLE DOT: draws like the middle dot; copy's NFKC turns U+FF65 into it, "Award・winning"),
 * "\u25CF" (U+25CF BLACK CIRCLE: a big bullet, "Award●winning").
 * A symbol with a space beside it is a list ("Plumbing · Austin", "Fast • Friendly • Local"), not a break inside a claim.
 * NAMED RESIDUAL: a separator with a space on either side ("Award · winning", "Award ·winning") reads as a list, not one claim;
 * a hyphen or dash with whitespace beside it is not joined either, as at main ("Award – winning").
 * Left out on purpose: "." (U+002E ends a sentence: a full stop typed without its space, "the same.Day one", would read "same Day"), ":" (U+003A introduces a
 * list) and "/" (U+002F offers alternatives); not "lic."/web addresses/"24/7" (the typed reading keeps those, and copy bans
 * digits). Also left out: "," ";" "!" "?" (end a clause, so they already split the words), "+" "=" "#" "&" "%" "^" "<" ">"
 * (read as operators or "and", not as a break between words), and the hyphen and dashes (the patterns join a glued hyphen or
 * dash themselves; one with whitespace beside it is not joined, as at main).
 */
const GLUED_SEPARATORS = /(?<=\S)[\u00B7\u2022~*|\u2219\u30FB\u25CF](?=\S)/g;

/**
 * The page read as typed, then folded every way (see the top of this file), and then each of those again with "_" (anywhere)
 * and a glued symbol separator (GLUED_SEPARATORS) read as a space: "_" is a word character, so it hides a claim word from
 * every rule that needs a word boundary, and a symbol glued between the words of a multi-word claim hides it from the patterns
 * that join the words with a hyphen or a space, while the reader sees the words whether a symbol or a space separates them.
 * The symbol becomes a space BEFORE asReadOnPage folds runs of whitespace, so a glued symbol next to "_" joins a multi-word
 * claim like one space ("Award _winning", "Same__day", "Award_·winning", "Award·_winning"). The typed readings stay as they are: a pattern
 * that matches through "_" on the typed reading still does ("licensed_crew": \blicen[cs]\w* runs through the "_"), while
 * "my_site.com" is found only by the separator reading. The separator readings only ever add a claim. claims.ts and
 * generation's ai-claims.ts both read through this function.
 */
export function readings(text: string): readonly string[] {
  const raw = [text, ...foldings(text)];
  // The glued symbols first, while a neighbouring "_" still counts as a character: "Award_·winning" and "Award·_winning"
  // (a glued symbol next to "_") would lose the symbol if "_" became a space first.
  const apart = (reading: string): string => reading.replace(GLUED_SEPARATORS, " ").replace(UNDERSCORE, " ");
  return [...raw.map(asReadOnPage), ...raw.filter((reading) => apart(reading) !== reading).map((reading) => asReadOnPage(apart(reading)))];
}

/**
 * The words in `text` that state a claim the owner's facts do not back (empty when the text is
 * fine), matched as a reader sees the page, read the ways above. A claim any reading finds counts,
 * so every word the typed reading alone finds is found. A found word is shown from the first reading that
 * finds it, as typed when it can be, so the owner can find it in the copy; the copy itself is not changed.
 */
export function unbackedClaims(text: string, facts: Facts): string[] {
  const read = readings(text);
  const claim = (pattern: RegExp): string | undefined => {
    for (const reading of read) {
      const word = pattern.exec(reading)?.[0];
      if (word !== undefined) return word;
    }
    return undefined;
  };
  const found: string[] = [];
  for (const pattern of NEVER_IN_COPY) {
    const word = claim(pattern);
    if (word !== undefined) found.push(word);
  }
  for (const { pattern, backedBy } of NEEDS_A_FACT) {
    const word = claim(pattern);
    if (word !== undefined && !backedBy(facts)) found.push(word);
  }
  return found;
}

type Path = Array<string | number>;

/**
 * Every prose string in the copy with its path, found by walking the object, so a copy field
 * added later is checked automatically. `service` keys are skipped: they repeat owner facts.
 */
export function proseIn(copy: Copy): Array<[Path, string]> {
  const out: Array<[Path, string]> = [];
  const walk = (value: unknown, path: Path): void => {
    if (typeof value === "string") out.push([path, value]);
    else if (Array.isArray(value)) value.forEach((item, i) => walk(item, [...path, i]));
    else if (typeof value === "object" && value !== null)
      for (const [key, item] of Object.entries(value)) if (key !== "service") walk(item, [...path, key]);
  };
  walk(copy, []);
  return out;
}
