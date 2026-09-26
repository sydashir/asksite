import { describe, expect, it } from "vitest";
import { Copy, COPY_LIMITS } from "../src/copy.ts";
import { UNICODE_17, unicodeVersion } from "./support/unicode-version.ts";

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

  // A9b, A9e: small capitals pass for A-Z letters ("ɪ", "ᴄ", "ꜱ"), so copy refuses them. Every other Latin letter is
  // allowed, phonetic letters included (A9e: real names and places use them); claims.ts reads the look-alikes listed in
  // lookalikes.ts ("ı", "ƒ", "Ł", "ɡ", "ə") as the A-Z letters they look like.
  /**
   * Every letter whose Unicode name says SMALL CAPITAL (UnicodeData.txt 18.0.0), in any block: 70 in Unicode 17.0 and the
   * eight Unicode 18.0 adds.
   */
  const SMALL_CAPITALS = [
    0x0262, 0x026a, 0x0274, 0x0276, 0x0280, 0x0281, 0x028f, 0x0299, 0x029b, 0x029c, 0x029f, 0x02b6, 0x1d00, 0x1d01,
    0x1d03, 0x1d04, 0x1d05, 0x1d06, 0x1d07, 0x1d0a, 0x1d0b, 0x1d0c, 0x1d0d, 0x1d0e, 0x1d0f, 0x1d10, 0x1d15, 0x1d18,
    0x1d19, 0x1d1a, 0x1d1b, 0x1d1c, 0x1d20, 0x1d21, 0x1d22, 0x1d23, 0x1d26, 0x1d27, 0x1d28, 0x1d29, 0x1d2a, 0x1d2b,
    0x1d7b, 0x1d7e, 0x1da6, 0x1da7, 0x1dab, 0x1db0, 0x1db8, 0x2c7b, 0xa730, 0xa731, 0xa776, 0xa7ae, 0xa7af, 0xa7fa,
    0xab46, 0xab65, 0x10780, 0x10784, 0x10792, 0x10794, 0x10796, 0x1079c, 0x107a3, 0x107aa, 0x107b2, 0x1df02,
    0x1df04, 0x1df10,
    // Unicode 18.0 (UnicodeData-18.0.0.txt); unassigned in this engine, so refused as unknown script
    0x1df30, 0x1df35, 0x1df36, 0x1df43, 0x1dfd1, 0x1dfe8, 0x1dfe9, 0x1dfea,
  ];
  /**
   * The Latin letters that look like a digit (copy.ts DIGIT_LETTER). A9c: those whose confusables.txt 18.0.0 skeleton,
   * with combining marks removed, is one ASCII digit (Ƨ 2, Ʒ 3, ƻ 2, Ƽ 5, Ǯ 3, Ȝ 3, Ȣ 8, ȣ 8, Ꝛ 2, Ꝫ 3, Ꝯ 9, ꝯ 9, Ɜ 3),
   * the other case of each (ƨ, ƽ, ȝ, ǯ, ʒ, ꝛ, ꝫ, ɜ), and the letters named after one of them "... WITH ..." (ƺ, ʓ, ᶚ and
   * U+1DF18 after EZH; ɝ and ᶔ after REVERSED OPEN E; U+1DF94 after R ROTUNDA). A9d: Ỽ and ỽ, MIDDLE-WELSH V, which
   * draw like a 6 but have no confusables.txt entry. A9e: the letters whose skeleton holds a digit or one of those letters
   * (ᴈ, ᴤ, ɮ, ʤ, Ꜩ, ꜩ) and the letters named after them; the cuatrillo (NamesList.txt: "x (digit four)"); and the letters
   * that draw as a digit in the code charts and the theme and Noto fonts (Ꜣ, Ꝝ, Ꝣ, ꝸ, ᵷ, ᵹ, Ꞁ, ꭋ, Ꟃ, Ꟑ, ꟼ).
   */
  const DIGIT_LETTERS = [
    0x01a7, 0x01a8, 0x01b7, 0x01ba, 0x01bb, 0x01bc, 0x01bd, 0x01ee, 0x01ef, 0x021c, 0x021d, 0x0222, 0x0223, 0x025c, 0x025d,
    0x0292, 0x0293, 0x1d94, 0x1d9a, 0xa75a, 0xa75b, 0xa76a, 0xa76b, 0xa76e, 0xa76f, 0xa7ab, 0x1df18,
    0x1df94, // Unicode 18.0 (UnicodeData-18.0.0.txt); unassigned in this engine
    0x1efc, 0x1efd, // A9d: Ỽ ỽ MIDDLE-WELSH V (Latin Extended Additional): a 6 and a small 6 in all six theme font stacks
    // A9e: confusables.txt skeletons that hold a digit or a digit letter (ɮ lȝ, ʤ dȝ, ᴈ ɜ, ᴤ ƨ, Ꜩ T3, ꜩ tȝ) and the letters
    // named after them (U+1DF05 LEZH WITH ..., U+1DF12 and U+1DF19 DEZH DIGRAPH WITH ...)
    0x026e, 0x02a4, 0x1d08, 0x1d24, 0xa728, 0xa729, 0x1df05, 0x1df12, 0x1df19,
    0x1df20, 0x1df2b, 0x1df67, // Unicode 18.0: D-LEZH DIGRAPH, DEZH DIGRAPH WITH CURL, LEZH WITH CURL; unassigned in this engine
    0xa72c, 0xa72d, 0xa72e, 0xa72f, // A9e: the cuatrillo, which NamesList.txt cross-refers to the digit four, and CUATRILLO WITH COMMA
    // A9e: drawn as a digit (Unicode 18.0 code charts; the macOS theme fonts; Noto Sans and Noto Serif)
    0xa722, 0xa723, 0xa75c, 0xa75d, 0xa762, 0xa763, 0xa778, 0x1d77, 0x1d79, 0xa780, 0xab4b, 0xab4c, 0xa7c2, 0xa7c3, 0xa7d0,
    0xa7d1, 0xa7fc,
    0xab6c, 0xab6d, // Unicode 18.0: the capitals of ꭋ and ꭌ; unassigned in this engine
  ];
  const NUMBER_MESSAGE = "Copy must not contain numbers, currency symbols, @ or links; facts come from the owner";
  const headlineWith = (letter: string) => issues({ ...valid, heroHeadline: `Crew ${letter} team` });
  const messagesFor = (headline: string) => {
    const result = Copy.safeParse({ ...valid, heroHeadline: headline });
    return result.success ? [] : result.error.issues.map((i) => i.message);
  };

  it("runs on the Unicode version the letter tables were derived from (17.0), so an upgrade is reviewed first", () => {
    // When this fails, derive SMALL_CAPITAL, DIGIT_LETTER (copy.ts), LOOKALIKES (lookalikes.ts) and the SMALL_CAPITALS
    // and DIGIT_LETTERS lists here again from the new Unicode data (support/unicode-version.ts; unicode.workerd.test.ts
    // asks the same inside workerd).
    expect(unicodeVersion()).toEqual(UNICODE_17);
  });

  it.each([
    "Call (ƧOȢ) ƼƼƼ-OlƧƷ", // renders like "(2O8) 555-Ol23"
    "Call l-ȢOO-ƼƼƼ-OƼȢƧ",
    "ƼO% off",
    "Ȝ crews",
    "Ǯ vans",
    "ƻ trucks",
    // A9c review: the small forms draw the same digits, smaller ("Call (255) 555-Ol23 today." in every theme font)
    "Call (ƨƽƽ) ƽƽƽ-Olƨȝ today.",
    "Save ƽO% on drain cleaning.",
    "ǯ vans",
    "ƺ trucks", // U+01BA ezh with tail
    // A9d: U+1EFC and U+1EFD MIDDLE-WELSH V draw as a 6 and a small 6 ("Save 6O% on drain cleaning."); confusables.txt has no entry
    "Save \u1EFCO% on drain cleaning.",
    "Call l-\u1EFC\u1EFCO-\u1EFDl\u1EFD",
    // A9e: letters of the blocks A9e opens that draw as a digit
    "Save \uA72DO% today", // ꜭ cuatrillo: "Save 4O% today" (NamesList.txt: x digit four)
    "Call l-\uA778\uA778\uA778-\uA722\uA723\uA723", // ꝸ reads 8, Ꜣ ꜣ read 3: "Call 1-888-333"
    "\uA75CO% off every drain", // Ꝝ rum rotunda: a 2 with a stroke
    "Top \uAB4Bated crew", // ꭋ script r draws like a 7 (Noto Sans), so it is refused as a number, not read as r
    "\uA780icensed crew", // Ꞁ turned L draws like a 7, like ⁊
    "Call \u1D08\u1D24", // ᴈ reads ɜ (3) and ᴤ reads ƨ (2) in confusables.txt
    "A crew of \uA728 vans", // Ꜩ reads T3 in confusables.txt
  ])("rejects a letter that looks like a digit as a number: %j", (headline) => {
    expect(messagesFor(headline)).toEqual([NUMBER_MESSAGE]);
  });

  it("rejects every letter that looks like a digit with the number message, in whichever block it is", () => {
    for (const cp of DIGIT_LETTERS) expect(messagesFor(`Crew ${String.fromCodePoint(cp)} team`), `U+${cp.toString(16)}`).toEqual([NUMBER_MESSAGE]);
  });

  it.each([
    "ʟɪᴄᴇɴꜱᴇᴅ plumbers", // small capitals
    "ɪnsured plumbers", // U+026A small capital I (IPA Extensions)
    "ᴄertified crew", // U+1D04 small capital C (Phonetic Extensions)
    "LꞮCENSED CREW", // U+A7AE capital letter small capital I (Latin Extended-D)
    "Insured for ⱻvery job", // U+2C7B small capital turned e (Latin Extended-C)
    "Top ꭆated crew", // U+AB46 small capital R with right leg (Latin Extended-E)
    "\u{1DF04}icensed crew", // small capital L with belt (Latin Extended-G)
    "ᴄʟᴇᴀɴ ʜᴏᴍᴇꜱ", // small capitals C L E A N H O M S
  ])("rejects a small capital: %j", (headline) => {
    expect(issues({ ...valid, heroHeadline: headline })).toEqual(["heroHeadline: custom"]);
  });

  // A9e: the other letters of the phonetic blocks pass Copy. The look-alikes among them are claims once read as A-Z
  // letters (lookalikes.ts; claims.test.ts), so a whole page still refuses these.
  it.each([
    "Licenʂed plumbers", // U+0282 s with hook (IPA Extensions): "Licensed"
    "Free ɡutter checks", // U+0261 script g
    "Licenᶊed crew", // U+1D8A s with palatal hook (Phonetic Extensions Supplement)
    "Ꝼree quotes", // U+A77B insular F (Latin Extended-D)
    "ꬶuaranteed results", // U+AB36 script g with crossed-tail (Latin Extended-E)
    "There is ꬼo charge", // U+AB3C eng with crossed-tail
    "Fully licꬳnsꬳd", // U+AB33 barred e
    "Our guarꬰntee", // U+AB30 barred alpha
    "Fully \u{1DF1A}nsured", // i with stroke and retroflex hook (Latin Extended-G)
  ])("accepts the other letters of the phonetic blocks in Copy, for claims.ts to read: %j", (headline) => {
    expect(issues({ ...valid, heroHeadline: headline })).toEqual([]);
  });

  it("rejects every small-capital letter, including those NFKC turns into one (U+02B6 becomes U+0281)", () => {
    for (const cp of SMALL_CAPITALS) expect(headlineWith(String.fromCodePoint(cp)), `U+${cp.toString(16)}`).toEqual(["heroHeadline: custom"]);
  });

  it("rejects exactly the small capitals and the digit look-alikes, and no other Latin or Common letter", () => {
    const wrong: string[] = [];
    for (let cp = 0x80; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const letter = String.fromCodePoint(cp);
      // Letters NFKC leaves alone (NFKC runs first); other scripts are refused by the Latin-script rule above.
      if (!/^\p{L}$/u.test(letter) || !/[\p{Script=Latin}\p{Script=Common}]/u.test(letter) || letter.normalize("NFKC") !== letter) continue;
      const expected = SMALL_CAPITALS.includes(cp) || DIGIT_LETTERS.includes(cp);
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
    expect(messages).toEqual(["AI copy must use Latin script letters, not small capitals such as ɪ, ᴄ or ꜱ"]);
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
    // A9e: letters of the phonetic blocks in real names and places (English Wikipedia titles; USGS GNIS)
    "Serving homes near Wewətanagok", // ə U+0259 (GNIS 580743)
    "Ayşən Əbdüləzimova and Aşiq Ələsgər", // Azerbaijani ə and Ə U+018F
    "Chevak Cupꞌik dialect", // U+A78C saltillo
    "ꞋAreꞌare language", // U+A78B and U+A78C
    "Grand Council (Miꞌkmaq)",
    "Ofon Na Ɛdi Asɛm Fo", // open e U+0190 and U+025B
    "Oberi Ɔkaimɛ", // open o U+0186
    "Akɔɔse and Anufɔ people", // open o U+0254
    "Eʋe and Kʋsaal", // U+028B v with hook
    "Agraw Imaziɣen", // U+0263 gamma
    "Fulɓe and Gaɗi language", // U+0253 b with hook, U+0257 d with hook
    "Aʔɨwa language", // U+0294 glottal stop, U+0268 i with stroke
    "Kwihnai Tosaabitʉ", // U+0289 u bar
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
