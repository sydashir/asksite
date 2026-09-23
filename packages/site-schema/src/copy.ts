import { z } from "zod";

// AI-written prose only. Every string has a hard length cap and is NFKC-normalised (so "＄８９"
// becomes "$89" before it is checked), then rejected if it contains:
// - a character Unicode classes as a number (\p{N}, e.g. "5", "٥", "½"), a currency symbol
//   (\p{Sc}), "@", "http:", "https:" or "www.";
// - a control or invisible formatting character (\p{Cc}, \p{Cf});
// - any character outside the Latin, Common (punctuation, symbols, emoji) and Inherited
//   (combining marks) scripts. Other scripts can write numbers and prices as letters ("五百元")
//   and have letters that look Latin (Cyrillic "о", U+043E).
// So copy cannot write a price, phone number, licence number, year or email in digits or symbols,
// or a link that starts "http:", "https:" or "www.". Not caught here: bare domains ("acme.com")
// and numbers spelled with Latin letters ("five", "XII"). Worded claims ("licensed", "free",
// "since") are checked against the owner's facts in claims.ts. Also not caught here: a
// default-ignorable combining mark or variation selector (Script=Inherited but not \p{Cc}/\p{Cf},
// e.g. U+034F COMBINING GRAPHEME JOINER or a U+FE00-U+FE0F variation selector) — claims.ts's
// HIDDEN_IN_COPY rejects those instead, once the full SiteDocument is checked, so that a
// legitimate variation-selector emoji such as "❤️" still parses through Copy alone.
// The renderer reads facts only from `facts`.
const FACT_LIKE = /[\p{N}\p{Sc}@]|https?:|www\./iu;
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}]/u;
const NON_LATIN_SCRIPT = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

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
