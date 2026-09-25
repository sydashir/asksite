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

  // A9b, A9c: letters from phonetic blocks can pass for A-Z letters ("ɪ", "ᴄ", "ꜱ", "ꬶ"), so copy refuses them,
  // except U+0294 ʔ, which official US place names use. Every other Latin letter is allowed; claims.ts reads the
  // look-alikes listed in lookalikes.ts ("ı", "ƒ", "Ł") as the A-Z letters they look like.
  const REFUSED_BLOCKS: ReadonlyArray<readonly [number, number]> = [
    [0x0250, 0x02af], // IPA Extensions
    [0x1d00, 0x1d7f], // Phonetic Extensions
    [0x1d80, 0x1dbf], // Phonetic Extensions Supplement
    [0xa720, 0xa7ff], // Latin Extended-D
    [0xab30, 0xab6f], // Latin Extended-E (A9c)
    [0x1df00, 0x1dfff], // Latin Extended-G (A9c)
  ];
  /** U+0294 LATIN LETTER GLOTTAL STOP (IPA Extensions): US Board on Geographic Names names use it (A9c). */
  const GLOTTAL_STOP = 0x0294;
  /** Every letter whose Unicode 17.0 name says SMALL CAPITAL (UnicodeData.txt), in any block. */
  const SMALL_CAPITALS = [
    0x0262, 0x026a, 0x0274, 0x0276, 0x0280, 0x0281, 0x028f, 0x0299, 0x029b, 0x029c, 0x029f, 0x02b6, 0x1d00, 0x1d01,
    0x1d03, 0x1d04, 0x1d05, 0x1d06, 0x1d07, 0x1d0a, 0x1d0b, 0x1d0c, 0x1d0d, 0x1d0e, 0x1d0f, 0x1d10, 0x1d15, 0x1d18,
    0x1d19, 0x1d1a, 0x1d1b, 0x1d1c, 0x1d20, 0x1d21, 0x1d22, 0x1d23, 0x1d26, 0x1d27, 0x1d28, 0x1d29, 0x1d2a, 0x1d2b,
    0x1d7b, 0x1d7e, 0x1da6, 0x1da7, 0x1dab, 0x1db0, 0x1db8, 0x2c7b, 0xa730, 0xa731, 0xa776, 0xa7ae, 0xa7af, 0xa7fa,
    0xab46, 0xab65, 0x10780, 0x10784, 0x10792, 0x10794, 0x10796, 0x1079c, 0x107a3, 0x107aa, 0x107b2, 0x1df02,
    0x1df04, 0x1df10,
  ];
  /**
   * The Latin letters whose confusables.txt 18.0.0 skeleton, with combining marks removed, is one ASCII digit (A9c):
   * Ƨ 2, Ʒ 3, ƻ 2, Ƽ 5, Ǯ 3 (Ʒ + caron), Ȝ 3, Ȣ 8, ȣ 8, and in Latin Extended-D Ꝛ 2, Ꝫ 3, Ꝯ 9, ꝯ 9, Ɜ 3.
   */
  const DIGIT_LETTERS = [0x01a7, 0x01b7, 0x01bb, 0x01bc, 0x01ee, 0x021c, 0x0222, 0x0223, 0xa75a, 0xa76a, 0xa76e, 0xa76f, 0xa7ab];
  const headlineWith = (letter: string) => issues({ ...valid, heroHeadline: `Crew ${letter} team` });
  const messagesFor = (headline: string) => {
    const result = Copy.safeParse({ ...valid, heroHeadline: headline });
    return result.success ? [] : result.error.issues.map((i) => i.message);
  };

  it.each([
    "Call (ƧOȢ) ƼƼƼ-OlƧƷ", // renders like "(2O8) 555-Ol23"
    "Call l-ȢOO-ƼƼƼ-OƼȢƧ",
    "ƼO% off",
    "Ȝ crews",
    "Ǯ vans",
    "ƻ trucks",
  ])("rejects a letter that looks like a digit as a number: %j", (headline) => {
    expect(messagesFor(headline)).toEqual(["Copy must not contain numbers, currency symbols, @ or links; facts come from the owner"]);
  });

  it("rejects exactly the letters confusables.txt reads as a digit, and not their other case", () => {
    for (const cp of DIGIT_LETTERS) expect(headlineWith(String.fromCodePoint(cp)), `U+${cp.toString(16)}`).toEqual(["heroHeadline: custom"]);
    expect(headlineWith("ƨ")).toEqual([]); // U+01A8, the small form of Ƨ
    expect(headlineWith("ȝ")).toEqual([]); // U+021D yogh, the small form of Ȝ
    expect(headlineWith("ǯ")).toEqual([]); // U+01EF, the small form of Ǯ
  });

  it("accepts U+0294 ʔ, which official US place names use (GNIS 260516 'dukMéʔem wáťa'), and still refuses other IPA letters", () => {
    expect(issues({ ...valid, heroHeadline: "Serving homes near dukMéʔem wáťa" })).toEqual([]);
    expect(issues({ ...valid, heroHeadline: "Serving Wewətanagok" })).toEqual(["heroHeadline: custom"]); // ə U+0259
  });

  it.each([
    "ʟɪᴄᴇɴꜱᴇᴅ plumbers", // small capitals
    "ɪnsured plumbers", // U+026A small capital I (IPA Extensions)
    "ᴄertified crew", // U+1D04 small capital C (Phonetic Extensions)
    "Licenʂed plumbers", // U+0282 s with hook (IPA Extensions)
    "Free ɡutter checks", // U+0261 script g (IPA Extensions)
    "Licenᶊed crew", // U+1D8A s with palatal hook (Phonetic Extensions Supplement)
    "LꞮCENSED CREW", // U+A7AE capital letter small capital I (Latin Extended-D)
    "Ꝼree quotes", // U+A77B insular F (Latin Extended-D)
    "Insured for ⱻvery job", // U+2C7B small capital turned e (Latin Extended-C)
    "Top ꭆated crew", // U+AB46 small capital R with right leg (Latin Extended-E)
    "\u{1DF04}icensed crew", // small capital L with belt (Latin Extended-G)
    "ꬶuaranteed results", // U+AB36 script g with crossed-tail (Latin Extended-E, A9c)
    "Top ꭋated crew", // U+AB4B script r
    "There is ꬼo charge", // U+AB3C eng
    "Fully licꬳnsꬳd", // U+AB33 barred e
    "Our guarꬰntee", // U+AB30 barred alpha
    "Fully \u{1DF1A}nsured", // i with stroke and retroflex hook (Latin Extended-G, A9c)
  ])("rejects a letter from a phonetic block: %j", (headline) => {
    expect(issues({ ...valid, heroHeadline: headline })).toEqual(["heroHeadline: custom"]);
  });

  it("rejects every small-capital letter, including those NFKC turns into one (U+02B6 becomes U+0281)", () => {
    for (const cp of SMALL_CAPITALS) expect(headlineWith(String.fromCodePoint(cp)), `U+${cp.toString(16)}`).toEqual(["heroHeadline: custom"]);
  });

  it("rejects exactly the letters of those blocks, the small capitals and the digit look-alikes, and no other Latin or Common letter", () => {
    const wrong: string[] = [];
    for (let cp = 0x80; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const letter = String.fromCodePoint(cp);
      // Letters NFKC leaves alone (NFKC runs first); other scripts are refused by the Latin-script rule above.
      if (!/^\p{L}$/u.test(letter) || !/[\p{Script=Latin}\p{Script=Common}]/u.test(letter) || letter.normalize("NFKC") !== letter) continue;
      const inRefusedBlock = cp !== GLOTTAL_STOP && REFUSED_BLOCKS.some(([from, to]) => cp >= from && cp <= to);
      const expected = inRefusedBlock || SMALL_CAPITALS.includes(cp) || DIGIT_LETTERS.includes(cp);
      if ((headlineWith(letter).length > 0) !== expected) wrong.push(`U+${cp.toString(16)} ${expected ? "accepted" : "refused"}`);
    }
    expect(wrong).toEqual([]);
  });

  it("accepts the symbols of those blocks that are not letters, like other punctuation", () => {
    expect(headlineWith("\uA789")).toEqual([]); // U+A789 modifier letter colon (Sk, Latin Extended-D)
    expect(headlineWith("\uA720")).toEqual([]); // U+A720 modifier letter stress and high tone (Sk)
  });

  it("reports a letter of another script once, with the script message, even next to a small capital", () => {
    const result = Copy.safeParse({ ...valid, heroHeadline: "Уборка ᴄrew" });
    expect(result.success ? [] : result.error.issues.map((i) => i.message)).toEqual([
      "AI copy must use Latin script only; other scripts can spell out numbers and prices",
    ]);
  });

  it("says which letters copy may use, in words Plan 3 and Plan 4 key on", () => {
    const result = Copy.safeParse({ ...valid, heroHeadline: "ɪnsured plumbers" });
    const messages = result.success ? [] : result.error.issues.map((i) => i.message);
    expect(messages).toEqual(["AI copy must use Latin script letters used in English, not phonetic letters or small capitals such as ɪ, ᴄ or ꜱ"]);
    expect(messages[0]?.startsWith("AI copy must use Latin script")).toBe(true);
  });

  it.each([
    "Café-clean kitchens",
    "No naïve guesswork",
    "Jalapeño stains lifted",
    "Cafe\u0301-clean kitchens", // e + U+0301 combining acute: the same é, decomposed
    "Crème brûlée spills, gone",
    // A9b: real US place names and people's names
    "Serving Hawaiʻi, Oʻahu and Kāneʻohe", // U+02BB ʻokina
    "Serving Hawaiʼi and Oʼahu", // U+02BC modifier letter apostrophe
    "Homes in Mānoa and Kailua-Kona",
    "Ask for Bjørn, Søren or Łukasz",
    "Đorđe fixes leaks fast",
    "From Straße to Cœur d’Alene",
    "Encyclopædia-level know-how",
    "José and Señor Crème",
    "Naïve café questions welcome",
    "Þórr runs the crew",
    "Lıcensed plumbers", // U+0131: Copy allows it; the claim checker reads it as "Licensed" (claims.test.ts)
    // A9c: real business names and words
    "Tiệm Giặt Sấy laundromat",
    "Ask for Saïd",
    "Génération Nouvelle Bakery",
    "Icelandic bönd, a décade, one dollár",
    "Near dukMéʔem wáťa", // U+0294 ʔ (A9c)
  ])("accepts every other Latin letter: %j", (headline) => {
    expect(issues({ ...valid, heroHeadline: headline })).toEqual([]);
  });

  it("reads compatibility forms of phonetic letters as the letters NFKC gives (ᴬ is A), before the letter check", () => {
    expect(Copy.parse({ ...valid, heroHeadline: "\u1D2Cward crew" }).heroHeadline).toBe("Award crew");
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
