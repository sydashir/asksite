import { z } from "zod";

// AI-written prose only. Every string has a hard length cap and is NFKC-normalised (so "＄８９"
// becomes "$89" before it is checked), then rejected if it contains:
// - a character Unicode classes as a number (\p{N}, e.g. "5", "٥", "½"), a currency symbol
//   (\p{Sc}), "@", "http:", "https:" or "www.", or a Latin letter that looks like a digit ("Ƨ", "ƨ", "Ƽ";
//   DIGIT_LETTER below, A9c);
// - a control or invisible formatting character (\p{Cc}, \p{Cf});
// - any character outside the Latin, Common (punctuation, symbols, emoji) and Inherited
//   (combining marks) scripts. Other scripts can write numbers and prices as letters ("五百元")
//   and have letters that look Latin (Cyrillic "о", U+043E);
// - a letter from a phonetic block, whose letters can pass for A-Z letters (A9b, A9c): phonetic letters and
//   small capitals such as "ɪ", "ᴄ", "ꬶ" and "ʟɪᴄᴇɴꜱᴇᴅ" (NON_ENGLISH_LETTER below). Accepted residual: a name
//   written with such a letter is refused too ("Wewətanagok", with ə).
//   Every other Latin letter passes: "café", "Bjørn", "Łukasz", "Straße", "Hawaiʻi" (U+02BB ʻokina), and the glottal
//   stop "ʔ" of official US place names ("dukMéʔem wáťa").
//   claims.ts reads the look-alikes listed in lookalikes.ts ("ı", "ƒ", "Ł") as A-Z letters.
// So copy cannot write a price, phone number, licence number, year or email in digits or symbols,
// or a link that starts "http:", "https:" or "www.". Not caught here: bare domains ("acme.com")
// and numbers spelled with Latin letters ("five", "XII"). Worded claims ("licensed", "free",
// "since") are checked against the owner's facts in claims.ts. Also not caught here: U+034F
// COMBINING GRAPHEME JOINER and the variation selectors (default-ignorable, Script=Inherited, not
// \p{Cc}/\p{Cf}). claims.ts's HIDDEN_IN_COPY rejects them when the whole SiteDocument is checked,
// except an emoji's own presentation selector (✔ then U+FE0F), which both checks accept.
// The renderer reads facts only from `facts`.
const FACT_LIKE = /[\p{N}\p{Sc}@]|https?:|www\./iu;

/**
 * Latin letters that look like a digit (A9c), derived from Unicode 18.0.0 data:
 * - every Latin letter whose skeleton in confusables.txt (UTS #39, Version 18.0.0 of 2026-08-06,
 *   https://www.unicode.org/Public/18.0.0/security/confusables.txt, Unicode License v3, notice in THIRD_PARTY_NOTICES.md),
 *   with combining marks removed, is one ASCII digit: Ƨ U+01A7 "2", Ʒ U+01B7 "3", ƻ U+01BB "2" (with a stroke), Ƽ U+01BC
 *   "5", Ǯ U+01EE "3" (Ʒ with a caron), Ȝ U+021C "3", Ȣ U+0222 and ȣ U+0223 "8", Ꝛ U+A75A "2", Ꝫ U+A76A "3", Ꝯ U+A76E
 *   and ꝯ U+A76F "9", Ɜ U+A7AB "3";
 * - the other case of each (UnicodeData.txt), which draws the same digit smaller, so "(ƨƽƽ) ƽƽƽ" reads "(255) 555":
 *   ƨ U+01A8, ƽ U+01BD, ǯ U+01EF, ȝ U+021D, ɜ U+025C, ʒ U+0292, ꝛ U+A75B, ꝫ U+A76B;
 * - the letters named after one of them "... WITH ...": ƺ U+01BA, ʓ U+0293, ᶚ U+1D9A, U+1DF18 (EZH), ɝ U+025D, ᶔ U+1D94
 *   (REVERSED OPEN E) and U+1DF94 (R ROTUNDA, Unicode 18.0).
 * Those in IPA Extensions, the Phonetic Extensions Supplement and Latin Extended-D and -G, which NON_ENGLISH_LETTER refuses
 * anyway, are listed too, so they get the number message. Not letters, so not listed: symbols that draw like a digit, such
 * as ⁊ U+204A, which looks like "7".
 */
const DIGIT_LETTER =
  /[\u01A7\u01A8\u01B7\u01BA-\u01BD\u01EE\u01EF\u021C\u021D\u0222\u0223\u025C\u025D\u0292\u0293\u1D94\u1D9A\uA75A\uA75B\uA76A\uA76B\uA76E\uA76F\uA7AB\u{1DF18}\u{1DF94}]/u;
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}]/u;
const NON_LATIN_SCRIPT = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

/**
 * Letters from phonetic blocks, whose letters can pass for A-Z letters (A9b, A9c; block ranges from Unicode's
 * Blocks.txt): U+0250-02AF IPA Extensions ("ɪ", "ʟ", "ɡ") except U+0294 ʔ LATIN LETTER GLOTTAL STOP, which
 * official US place names use (US Board on Geographic Names, GNIS 260516 "dukMéʔem wáťa"); U+1D00-1D7F Phonetic
 * Extensions and U+1D80-1DBF Phonetic Extensions Supplement ("ᴄ", "ᴇ"); U+A720-A7FF Latin Extended-D ("ꜱ", "Ɪ",
 * "Ꝼ"); U+AB30-AB6F Latin Extended-E ("ꬶ", "ꭋ") and U+1DF00-1DFFF Latin Extended-G; and the two other letters
 * whose Unicode name says SMALL CAPITAL, U+2C7B and U+10780 (UnicodeData.txt 17.0 and 18.0). The modifier-letter
 * small capitals (U+02B6, U+10784 and others) become one of these under NFKC, which runs first. Symbols in these
 * blocks that are not letters (U+A720, U+A789) are allowed, like other punctuation.
 */
const NON_ENGLISH_LETTER = /(?=\p{L})[\u0250-\u0293\u0295-\u02AF\u1D00-\u1DBF\uA720-\uA7FF\uAB30-\uAB6F\u2C7B\u{10780}\u{1DF00}-\u{1DFFF}]/u;

export const prose = (max: number) =>
  z
    .string()
    .normalize("NFKC")
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !FACT_LIKE.test(s) && !DIGIT_LETTER.test(s), {
      error: "Copy must not contain numbers, currency symbols, @ or links; facts come from the owner",
    })
    .refine((s) => !HIDDEN_CHARACTER.test(s), { error: "Copy must not contain control or invisible characters" })
    .refine((s) => !NON_LATIN_SCRIPT.test(s), {
      error: "AI copy must use Latin script only; other scripts can spell out numbers and prices",
      // Runs only if every check above passed, so a non-Latin digit such as "٥" is reported once.
      // It changes which message is shown, never whether a string is rejected.
      when: (payload) => payload.issues.length === 0,
    })
    .refine((s) => !NON_ENGLISH_LETTER.test(s), {
      // Starts like the message above, so callers that key on "AI copy must use Latin script" (Plan 3's
      // repair rules, Plan 4's owner messages) treat both alike.
      error: "AI copy must use Latin script letters used in English, not phonetic letters or small capitals such as ɪ, ᴄ or ꜱ",
      when: (payload) => payload.issues.length === 0, // as above: a non-Latin letter gets only the message above
    });

export const COPY_LIMITS = {
  heroHeadline: 80,
  heroSubheadline: 160,
  ctaText: 24,
  about: 480,
  sectionIntro: 140,
  serviceDescription: 160,
  faqQuestion: 80,
  faqAnswer: 320,
} as const;

/**
 * Intros only for sections whose body is not a list of owner facts. Reviews and the service
 * area get no AI subtitle, so AI prose never sits above real reviews or the owner's hours.
 */
export const SectionIntros = z.strictObject({
  services: prose(COPY_LIMITS.sectionIntro).optional(),
  gallery: prose(COPY_LIMITS.sectionIntro).optional(),
  faq: prose(COPY_LIMITS.sectionIntro).optional(),
  contact: prose(COPY_LIMITS.sectionIntro).optional(),
});

/**
 * `service` repeats the owner's service name exactly (it is never rendered; the page shows the
 * name from facts). SiteDocument checks it, so a reordered or missing description is caught.
 */
export const ServiceDescription = z.strictObject({
  service: z.string().trim().min(1).max(40),
  description: prose(COPY_LIMITS.serviceDescription),
});

export const FaqItem = z.strictObject({
  question: prose(COPY_LIMITS.faqQuestion),
  answer: prose(COPY_LIMITS.faqAnswer),
});

export const Copy = z.strictObject({
  heroHeadline: prose(COPY_LIMITS.heroHeadline),
  heroSubheadline: prose(COPY_LIMITS.heroSubheadline),
  /** Label for the quote button and the contact heading, e.g. "Get a free quote". */
  ctaText: prose(COPY_LIMITS.ctaText),
  about: prose(COPY_LIMITS.about).optional(),
  sectionIntros: SectionIntros.default({}),
  /** One entry per owner service, in facts.services order. */
  serviceDescriptions: z.array(ServiceDescription).max(12),
  faq: z.array(FaqItem).max(8).default([]),
});

export type Copy = z.infer<typeof Copy>;
export type FaqItem = z.infer<typeof FaqItem>;
