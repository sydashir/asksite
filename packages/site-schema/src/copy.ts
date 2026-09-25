import { z } from "zod";

// AI-written prose only. Every string has a hard length cap and is NFKC-normalised (so "＄８９"
// becomes "$89" before it is checked), then rejected if it contains:
// - a character Unicode classes as a number (\p{N}, e.g. "5", "٥", "½"), a currency symbol
//   (\p{Sc}), "@", "http:", "https:" or "www.";
// - a control or invisible formatting character (\p{Cc}, \p{Cf});
// - any character outside the Latin, Common (punctuation, symbols, emoji) and Inherited
//   (combining marks) scripts. Other scripts can write numbers and prices as letters ("五百元")
//   and have letters that look Latin (Cyrillic "о", U+043E);
// - a letter from a block never used in real English copy, whose letters can pass for A-Z letters
//   (A9b): phonetic letters and small capitals such as "ɪ", "ᴄ" and "ʟɪᴄᴇɴꜱᴇᴅ" (NON_ENGLISH_LETTER below).
//   Every other Latin letter passes: "café", "Bjørn", "Łukasz", "Straße", "Hawaiʻi" (U+02BB ʻokina).
//   claims.ts reads the look-alikes among them ("ı", "ƒ", "Ł") as A-Z letters (lookalikes.ts).
// So copy cannot write a price, phone number, licence number, year or email in digits or symbols,
// or a link that starts "http:", "https:" or "www.". Not caught here: bare domains ("acme.com")
// and numbers spelled with Latin letters ("five", "XII"). Worded claims ("licensed", "free",
// "since") are checked against the owner's facts in claims.ts. Also not caught here: U+034F
// COMBINING GRAPHEME JOINER and the variation selectors (default-ignorable, Script=Inherited, not
// \p{Cc}/\p{Cf}). claims.ts's HIDDEN_IN_COPY rejects them when the whole SiteDocument is checked,
// except an emoji's own presentation selector (✔ then U+FE0F), which both checks accept.
// The renderer reads facts only from `facts`.
const FACT_LIKE = /[\p{N}\p{Sc}@]|https?:|www\./iu;
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}]/u;
const NON_LATIN_SCRIPT = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

/**
 * Letters from blocks never used in real English copy, whose letters can pass for A-Z letters (A9b; block
 * ranges from Unicode's Blocks.txt): U+0250-02AF IPA Extensions ("ɪ", "ʟ", "ɡ"), U+1D00-1D7F Phonetic
 * Extensions and U+1D80-1DBF Phonetic Extensions Supplement ("ᴄ", "ᴇ"), U+A720-A7FF Latin Extended-D ("ꜱ",
 * "Ɪ", "Ꝼ"), and every other letter whose Unicode name says SMALL CAPITAL: U+2C7B, U+AB46, U+10780,
 * U+1DF02, U+1DF04 and U+1DF10 (UnicodeData.txt 17.0), plus U+1DF30, U+1DF35, U+1DF36 and U+1DF43, which
 * Unicode 18.0 adds (until Node knows them, the Latin-script rule above refuses them as unassigned). The
 * modifier-letter small capitals (U+02B6, U+10784 and others) become one of these under NFKC, which runs first.
 * Symbols in these blocks that are not letters (U+A720, U+A789) are allowed, like other punctuation.
 */
const NON_ENGLISH_LETTER =
  /(?=\p{L})[\u0250-\u02AF\u1D00-\u1DBF\uA720-\uA7FF\u2C7B\uAB46\u{10780}\u{1DF02}\u{1DF04}\u{1DF10}\u{1DF30}\u{1DF35}\u{1DF36}\u{1DF43}]/u;

export const prose = (max: number) =>
  z
    .string()
    .normalize("NFKC")
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !FACT_LIKE.test(s), {
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
