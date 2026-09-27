import { z } from "zod";

// AI-written prose only. Every string has a hard length cap and is NFKC-normalised (so "＄８９"
// becomes "$89" before it is checked), then rejected if it contains:
// - a character Unicode classes as a number (\p{N}, e.g. "5", "٥", "½"), a currency symbol
//   (\p{Sc}), "@", "http:", "https:" or "www.", or one of the Latin letters listed in DIGIT_LETTER below, which
//   look like a digit ("Ƨ", "ƨ", "Ƽ", A9c; "Ỽ", A9d; "ꜭ", "ᴈ", A9e; "Ɥ", A9f);
// - a control or invisible formatting character (\p{Cc}, \p{Cf});
// - any character outside the Latin, Common (punctuation, symbols, emoji) and Inherited
//   (combining marks) scripts. Other scripts can write numbers and prices as letters ("五百元")
//   and have letters that look Latin (Cyrillic "о", U+043E);
// - a small capital, which looks like an A-Z letter (A9b, A9e): "ɪ", "ᴄ", "ꜱ" and "ʟɪᴄᴇɴꜱᴇᴅ" (SMALL_CAPITAL below);
// - (A9g) a character in U+A7F7-A7FF, the Latin epigraphic letters "ꟷ", "ꟻ", "ꟽ", "ꟾ" and "ꟿ" (EPIGRAPHIC_LETTER below).
//   Every other Latin letter passes (A9e), phonetic letters included, because real names and places use them:
//   "café", "Bjørn", "Łukasz", "Straße", "Hawaiʻi" (U+02BB ʻokina), the glottal stop "ʔ" of official US place names
//   ("dukMéʔem wáťa"), the schwa of Azerbaijani names and US place names ("Rəşad", "Wewətanagok"), the saltillo of Alaska
//   Native and Mesoamerican languages ("Cupꞌik") and the open e and open o of West African names ("ɛ", "ɔ").
//   claims.ts reads the look-alikes listed in lookalikes.ts ("ı", "ƒ", "Ł", "ɡ", "ə") as A-Z letters.
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
 * Latin letters that look like a digit, derived from Unicode 18.0.0 data (confusables.txt: UTS #39, Version 18.0.0 of
 * 2026-08-06, https://www.unicode.org/Public/18.0.0/security/confusables.txt, Unicode License v3, notice in
 * THIRD_PARTY_NOTICES.md):
 * - (A9c) every Latin letter whose confusables.txt skeleton, with combining marks removed, is one ASCII digit: Ƨ U+01A7
 *   "2", Ʒ U+01B7 "3", ƻ U+01BB "2" (with a stroke), Ƽ U+01BC "5", Ǯ U+01EE "3" (Ʒ with a caron), Ȝ U+021C "3", Ȣ U+0222
 *   and ȣ U+0223 "8", Ꝛ U+A75A "2", Ꝫ U+A76A "3", Ꝯ U+A76E and ꝯ U+A76F "9", Ɜ U+A7AB "3";
 * - (A9c) the other case of each (UnicodeData.txt), which draws the same digit smaller, so "(ƨƽƽ) ƽƽƽ" reads "(255) 555":
 *   ƨ U+01A8, ƽ U+01BD, ǯ U+01EF, ȝ U+021D, ɜ U+025C, ʒ U+0292, ꝛ U+A75B, ꝫ U+A76B;
 * - (A9c) the letters named after one of them "... WITH ...": ƺ U+01BA, ʓ U+0293, ᶚ U+1D9A, U+1DF18 (EZH), ɝ U+025D, ᶔ
 *   U+1D94 (REVERSED OPEN E) and U+1DF94 (R ROTUNDA, Unicode 18.0);
 * - (A9d) Ỽ U+1EFC and ỽ U+1EFD, MIDDLE-WELSH V, which draw as a 6 and a small 6 in all six theme font stacks
 *   (Playwright's Chromium and WebKit on macOS) but have no confusables.txt entry, so "Save ỼO%" reads "Save 6O%";
 * - (A9e) the letters whose confusables.txt skeleton holds a digit or one of the letters above: ᴈ U+1D08 (ɜ), ᴤ U+1D24
 *   (ƨ), ɮ U+026E (l + ȝ), ʤ U+02A4 (d + ȝ), Ꜩ U+A728 (T + 3), ꜩ U+A729 (t + ȝ), and U+1DF20 (d + l + ȝ), U+1DF2B (d + ʓ)
 *   and U+1DF67 (l + ʓ) of Unicode 18.0; and the letters named after one of them "... WITH ...": U+1DF05 (LEZH),
 *   U+1DF12 and U+1DF19 (DEZH DIGRAPH);
 * - (A9e) ꜭ U+A72D CUATRILLO, which NamesList.txt cross-refers to the digit four, its capital Ꜭ U+A72C and the two
 *   named after it, Ꜯ U+A72E and ꜯ U+A72F (CUATRILLO WITH COMMA);
 * - (A9e) letters that draw as a digit in the Unicode 18.0 code charts, in the macOS fonts of the theme stacks or in Noto
 *   Sans and Noto Serif (the fallback fonts of Android), though confusables.txt has no digit for them: Ꜣ U+A722 and ꜣ
 *   U+A723 (3), Ꝝ U+A75C and ꝝ U+A75D (2 with a stroke), Ꝣ U+A762 and ꝣ U+A763 (3), ꝸ U+A778 (8), ᵷ U+1D77 (6 or 8),
 *   ᵹ U+1D79 (3), Ꞁ U+A780 and ꭋ U+AB4B (7, like ⁊), Ꟃ U+A7C2 and ꟃ U+A7C3 ("V3"), Ꟑ U+A7D0 (8) and ꟑ U+A7D1 (3), ꟼ
 *   U+A7FC (9); ꭌ U+AB4C, named after ꭋ; and U+AB6C and U+AB6D, the capitals of ꭋ and ꭌ (Unicode 18.0);
 * - (A9f) Ɥ U+A78D and ɥ U+0265, TURNED H, which draw like an open 4 (the moderator's A9f ruling, from the A9e review's
 *   render of the six theme font stacks; confusables.txt has no digit for them, and NamesList.txt cross-refers Ɥ to
 *   Cyrillic Ч U+0427), the letters named after ɥ "... WITH ...": ʮ U+02AE and ʯ U+02AF (TURNED H WITH FISHHOOK, AND
 *   TAIL), and U+1DF3E BARRED TURNED H of Unicode 18.0, whose confusables.txt skeleton is ɥ + U+0335.
 * Not letters, so not listed: symbols that draw like a digit, such as ⁊ U+204A, which looks like "7".
 */
const DIGIT_LETTER =
  /[ƧƨƷƺ-ƽǮǯȜȝȢȣɜɝɥɮʒʓʤʮʯᴈᴤᵷᵹᶔᶚỼỽꜢꜣꜨꜩꜬ-ꜯꝚ-ꝝꝢꝣꝪꝫꝮꝯꝸꞀꞍꞫꟂꟃꟐꟑꟼꭋꭌ꭬꭭\u{1DF05}\u{1DF12}\u{1DF18}\u{1DF19}\u{1DF20}\u{1DF2B}\u{1DF3E}\u{1DF67}\u{1DF94}]/u;
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}]/u;
const NON_LATIN_SCRIPT = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

/**
 * The small capitals (A9b, A9e), which look like A-Z letters ("ᴄ", "ʀ", "ꜱ"): every letter whose Unicode name says SMALL
 * CAPITAL (UnicodeData.txt 18.0.0, 78 letters, in IPA Extensions, the Phonetic Extensions and Latin Extended-C, -D, -E, -F
 * and -G), the modifier (superscript) small capitals included. NFKC runs first and turns most modifier small capitals
 * (U+02B6, U+1DA6, U+10784...) into one of these; U+10780 has no such mapping and is listed itself. The eight Unicode
 * 18.0 adds (U+1DF30, U+1DF35, U+1DF36, U+1DF43, U+1DFD1, U+1DFE8-1DFEA) are unassigned in this engine, which refuses
 * them as an unknown script; they are listed so an engine upgrade keeps refusing them. The Greek and Cyrillic small
 * capitals (U+1D26-1D2B, U+AB65) are refused as another script first.
 */
const SMALL_CAPITAL =
  /[ɢɪɴɶʀʁʏʙʛʜʟʶᴀᴁᴃ-ᴇᴊ-ᴐᴕᴘ-ᴜᴠ-ᴣᴦ-ᴫᵻᵾᶦᶧᶫᶰᶸⱻꜰꜱꝶꞮꞯꟺꭆꭥ\u{10780}\u{10784}\u{10792}\u{10794}\u{10796}\u{1079C}\u{107A3}\u{107AA}\u{107B2}\u{1DF02}\u{1DF04}\u{1DF10}\u{1DF30}\u{1DF35}\u{1DF36}\u{1DF43}\u{1DFD1}\u{1DFE8}-\u{1DFEA}]/u;

/**
 * A9g: U+A7F7-A7FF, whose letters UnicodeData.txt 18.0.0 names LATIN EPIGRAPHIC LETTER (U+A7F7 SIDEWAYS I, U+A7FB-A7FF
 * REVERSED F, REVERSED P, INVERTED M, I LONGA and ARCHAIC M): letters of ancient Roman and Celtic inscriptions, with no use
 * in English copy or in real names, which the claim checker can only read by guessing (ꟾ reads i or l, so "ꟾꟾcensed" hid
 * "licensed"). lookalikes.ts keeps their readings, which is harmless. The rest of the range is refused before this check:
 * U+A7FA is a small capital and U+A7FC looks like a digit, and NFKC turns U+A7F8 and U+A7F9 (superscript letters for IPA
 * and UPA) into Ħ and œ. So copy never holds a character of this range.
 */
const EPIGRAPHIC_LETTER = /[\uA7F7-\uA7FF]/u;

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
    .refine((s) => !SMALL_CAPITAL.test(s), {
      // Starts like the message above, so callers that key on "AI copy must use Latin script" (Plan 3's
      // repair rules, Plan 4's owner messages) treat both alike.
      error: "AI copy must use Latin script letters, not small capitals such as ɪ, ᴄ or ꜱ",
      when: (payload) => payload.issues.length === 0, // as above: a non-Latin letter gets only the message above
    })
    .refine((s) => !EPIGRAPHIC_LETTER.test(s), {
      // A9g: starts like the two messages above, for the callers that key on it; one message per string, as above.
      error: "AI copy must use Latin script letters, not epigraphic letters such as ꟾ or ꟽ",
      when: (payload) => payload.issues.length === 0,
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
