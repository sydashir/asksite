import { describe, expect, it } from "vitest";
import { prose } from "../src/copy.ts";
import { foldLookalikes, LOOKALIKES } from "../src/lookalikes.ts";

/** Every [letter, A-Z letters] pair of the table. */
const PAIRS = Object.entries(LOOKALIKES).flatMap(([ascii, letters]) => Array.from(letters, (letter) => [letter, ascii] as const));
const READS = new Map(PAIRS);
const APOSTROPHES = new Set(["\u02BB", "\u02BC"]);

describe("foldLookalikes (A9b)", () => {
  it.each([
    ["ı", "i"],
    ["ȷ", "j"],
    ["ø", "o"],
    ["ł", "l"],
    ["đ", "d"],
    ["ħ", "h"],
    ["ŧ", "t"],
    ["ƀ", "b"],
    ["ƒ", "f"],
    ["ß", "ss"],
    ["æ", "ae"],
    ["œ", "oe"],
    ["þ", "th"],
    ["ð", "d"],
    ["Ø", "O"],
    ["Ł", "L"],
    ["Đ", "D"],
    ["Ħ", "H"],
    ["Ŧ", "T"],
    ["Ƀ", "B"],
    ["Ƒ", "F"],
    ["ẞ", "SS"],
    ["Æ", "AE"],
    ["Œ", "OE"],
    ["Þ", "TH"],
    ["Ð", "D"],
    ["\u02BB", "'"], // ʻokina
    ["\u02BC", "'"], // modifier letter apostrophe
  ])("reads %j as %j", (letter, ascii) => {
    expect(foldLookalikes(letter)).toBe(ascii);
  });

  it.each([
    ["Ɩ", "I"], // U+0196 capital iota: confusables.txt's prototype "l" stands for I and l; named for I
    ["Ɨ", "I"], // U+0197 capital I with stroke
    ["ǀ", "l"], // U+01C0 dental click: prototype "l"
    ["ĸ", "k"], // U+0138 kra: NamesList cross-refers it to U+1D0B small capital K
    ["ŋ", "n"], // U+014B eng: confusables.txt n + U+0329
    ["Ŋ", "N"], // U+014A: the other case of ŋ
    ["Ɓ", "B"], // U+0181 B with hook: its Unicode name
    ["ꭑ", "rn"], // U+AB51 turned ui: confusables.txt r + n
    ["\u{1DF1A}", "i"], // i with stroke and retroflex hook: its Unicode name
  ])("reads the look-alike %j as %j", (letter, ascii) => {
    expect(foldLookalikes(letter)).toBe(ascii);
  });

  it("removes accents and other combining marks first (NFD), then reads the look-alikes", () => {
    expect(foldLookalikes("Bjørn, Søren, Łukasz, Đorđe, Straße, Cœur d’Alene, Encyclopædia, Þórr, José, Señor, Crème, naïve, café")).toBe(
      "Bjorn, Soren, Lukasz, Dorde, Strasse, Coeur d’Alene, Encyclopaedia, THorr, Jose, Senor, Creme, naive, cafe",
    );
    expect(foldLookalikes("Hawaiʻi, Oʻahu, Kāneʻohe, Mānoa, Kailua-Kona")).toBe("Hawai'i, O'ahu, Kane'ohe, Manoa, Kailua-Kona");
    expect(foldLookalikes("ǿ Ǿ ǽ Ǣ")).toBe("o O ae AE"); // ø, Ø, æ and Æ with a mark
    expect(foldLookalikes("Licen\u0336sed")).toBe("Licensed"); // U+0336 combining long stroke overlay
  });

  it("leaves ASCII, punctuation and letters that look like no A-Z letter as they are", () => {
    const ascii = Array.from({ length: 0x80 }, (_, c) => String.fromCharCode(c)).join("");
    expect(foldLookalikes(ascii)).toBe(ascii);
    expect(foldLookalikes("Fast — friendly ’ “ ” ✨ Ǝ Ɔ Ʃ Ʒ Ƽ")).toBe("Fast — friendly ’ “ ” ✨ Ǝ Ɔ Ʃ Ʒ Ƽ");
  });

  it("lists only single letters that copy accepts and NFD leaves whole, each read as A-Z letters", () => {
    for (const [letter, ascii] of PAIRS) {
      expect(letter, letter).toMatch(/^\p{L}$/u);
      expect(letter, letter).not.toMatch(/^[A-Za-z]$/);
      expect(letter.normalize("NFD"), letter).toBe(letter);
      expect(letter.normalize("NFKC"), letter).toBe(letter);
      expect(prose(80).safeParse(`Crew ${letter} team`).success, letter).toBe(true);
      expect(ascii, letter).toMatch(APOSTROPHES.has(letter) ? /^'$/ : /^[A-Za-z]+$/);
    }
    expect(READS.size).toBe(PAIRS.length); // no letter listed twice
    expect(PAIRS).toHaveLength(163); // the A9b derivation (lookalikes.ts); a changed table must be derived again
  });

  it("reads a capital as capitals and any other letter as small letters", () => {
    for (const [letter, ascii] of PAIRS) {
      if (APOSTROPHES.has(letter)) continue;
      expect(ascii, letter).toBe(/\p{Lu}/u.test(letter) ? ascii.toUpperCase() : ascii.toLowerCase());
    }
  });

  it("lists the other case of each letter too, as the same letters, when copy accepts it", () => {
    // Ƽ U+01BC, the capital of ƽ (read as s), looks like the digit 5 (confusables.txt), so it is left out.
    const LEFT_OUT = new Set(["Ƽ"]);
    const missing: string[] = [];
    for (const [letter, ascii] of PAIRS) {
      for (const other of [letter.toUpperCase(), letter.toLowerCase()]) {
        if (other === letter || [...other].length !== 1 || /^[A-Za-z]$/.test(other) || LEFT_OUT.has(other)) continue;
        if (!prose(80).safeParse(`Crew ${other} team`).success) continue; // e.g. ɓ, the small form of Ɓ, is IPA
        if (READS.get(other)?.toLowerCase() !== ascii.toLowerCase()) missing.push(`${letter} -> ${other}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
