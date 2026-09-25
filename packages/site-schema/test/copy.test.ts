import { describe, expect, it } from "vitest";
import { Copy, COPY_LIMITS } from "../src/copy.ts";

const valid = {
  heroHeadline: "Fast, friendly plumbing in Austin",
  heroSubheadline: "Leaks, clogs and water heaters fixed right the first time.",
  ctaText: "Get a free quote",
  serviceDescriptions: [{ service: "Drain cleaning", description: "We clear stubborn drains without tearing up your yard." }],
};

const issues = (input: unknown) => {
  const result = Copy.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.code}`);
};

describe("Copy", () => {
  it("parses valid copy and fills defaults", () => {
    const copy = Copy.parse(valid);
    expect(copy.faq).toEqual([]);
    expect(copy.sectionIntros).toEqual({});
  });

  it.each(Object.entries({ heroHeadline: 80, heroSubheadline: 160, ctaText: 24, about: 480 }))(
    "caps %s at %i characters",
    (field, max) => {
      expect(issues({ ...valid, [field]: "a".repeat(max) })).toEqual([]);
      expect(issues({ ...valid, [field]: "a".repeat(max + 1) })).toEqual([`${field}: too_big`]);
    },
  );

  it("caps section intros, service descriptions and FAQ items", () => {
    expect(issues({ ...valid, sectionIntros: { faq: "a".repeat(141) } })).toEqual(["sectionIntros.faq: too_big"]);
    expect(issues({ ...valid, serviceDescriptions: [{ service: "Drains", description: "a".repeat(161) }] })).toEqual([
      "serviceDescriptions.0.description: too_big",
    ]);
    expect(issues({ ...valid, faq: [{ question: "a".repeat(81), answer: "b" }] })).toEqual(["faq.0.question: too_big"]);
    expect(issues({ ...valid, faq: [{ question: "a", answer: "b".repeat(321) }] })).toEqual(["faq.0.answer: too_big"]);
    expect(issues({ ...valid, faq: Array(9).fill({ question: "a", answer: "b" }) })).toEqual(["faq: too_big"]);
  });

  it("has no AI intro for reviews or the service area", () => {
    expect(issues({ ...valid, sectionIntros: { testimonials: "Real reviews" } })).toEqual(["sectionIntros: unrecognized_keys"]);
    expect(issues({ ...valid, sectionIntros: { serviceArea: "All of Texas" } })).toEqual(["sectionIntros: unrecognized_keys"]);
  });

  it("exposes the limits for the AI prompt (plan 3)", () => {
    expect(COPY_LIMITS.heroHeadline).toBe(80);
  });

  it.each([
    "Call (512) 555-0142 today",
    "Drain cleaning from $89",
    "Licence ROC 300933",
    "Serving Austin since 1998",
    "Email us at office@example.com",
    "Visit https://evil.example.com",
    "Visit www.evil.example.com",
    "Call ２０８ ５５５ ０１０７",
    "Only ＄８９",
    "Only €89",
    "Call ٥١٢",
    "Half price, just ½ off",
  ])("rejects a fact smuggled into copy: %j", (headline) => {
    expect(issues({ ...valid, heroHeadline: headline })).toEqual(["heroHeadline: custom"]);
  });

  it("rejects control and invisible characters", () => {
    expect(issues({ ...valid, heroHeadline: "Visit ww​w.evil.example" })).toEqual(["heroHeadline: custom"]);
    expect(issues({ ...valid, heroHeadline: "Mop‮etis" })).toEqual(["heroHeadline: custom"]);
  });

  it.each([
    "五百元", // "five hundred yuan": numerals and currency written as Han letters
    "十年经验", // "ten years' experience"
    "Уборка", // Cyrillic
    "Καθαρισμός", // Greek
    "Licensed and b\u043Ended", // U+043E is Cyrillic small letter o, which looks like Latin "o"
  ])("rejects letters outside the Latin script: %j", (headline) => {
    expect(issues({ ...valid, heroHeadline: headline })).toEqual(["heroHeadline: custom"]);
  });

  it("says copy must use Latin script", () => {
    const result = Copy.safeParse({ ...valid, heroHeadline: "Уборка" });
    expect(result.success ? [] : result.error.issues.map((i) => i.message)).toEqual([
      expect.stringContaining("Latin script"),
    ]);
  });

  // A9: Latin-script letters that are not A-Z once their accents are removed can pass for A-Z letters
  // (U+0131 dotless i reads as "i"), so a claim word spelled with them would slip past claims.ts.
  it.each([
    "Lıcensed plumbers", // U+0131 dotless i
    "ʟɪᴄᴇɴꜱᴇᴅ plumbers", // small capitals
    "Licenʂed plumbers", // U+0282 s with hook
    "Straße repairs", // U+00DF sharp s
    "Encyclopædia of cleaning", // U+00E6 ae
  ])("rejects a letter that is not A-Z once its accents are removed: %j", (headline) => {
    expect(issues({ ...valid, heroHeadline: headline })).toEqual(["heroHeadline: custom"]);
  });

  it("says which letters copy may use", () => {
    const result = Copy.safeParse({ ...valid, heroHeadline: "Lıcensed plumbers" });
    expect(result.success ? [] : result.error.issues.map((i) => i.message)).toEqual([
      "AI copy must use Latin script letters A to Z, with or without accents (é and ñ are fine; ı, ß, æ and small capitals are not)",
    ]);
  });

  it.each([
    "Café-clean kitchens",
    "No naïve guesswork",
    "Jalapeño stains lifted",
    "Cafe\u0301-clean kitchens", // e + U+0301 combining acute: the same é, decomposed
    "Crème brûlée spills, gone",
  ])("accepts letters that are A-Z once their accents are removed: %j", (headline) => {
    expect(issues({ ...valid, heroHeadline: headline })).toEqual([]);
  });

  it.each([
    "café repairs",
    "Fast — friendly service",
    "We’re ‘quick’ and “careful”",
    "Clean homes ✨",
    "Leak fixed ✔️", // emoji with variation selector U+FE0F (Inherited script)
  ])("accepts Latin letters, accents, typographic punctuation and emoji: %j", (headline) => {
    expect(issues({ ...valid, heroHeadline: headline })).toEqual([]);
  });

  it("normalises compatibility characters before checking", () => {
    expect(Copy.parse({ ...valid, ctaText: "Ｃａｌｌ ｕｓ" }).ctaText).toBe("Call us");
  });

  it("rejects fact fields placed in copy", () => {
    expect(issues({ ...valid, phone: "+15125550142" })).toEqual([": unrecognized_keys"]);
  });

  it("trims whitespace and rejects empty strings", () => {
    expect(Copy.parse({ ...valid, ctaText: "  Call us  " }).ctaText).toBe("Call us");
    expect(issues({ ...valid, ctaText: "   " })).toEqual(["ctaText: too_small"]);
  });
});
