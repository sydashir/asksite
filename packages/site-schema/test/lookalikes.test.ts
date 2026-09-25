import { describe, expect, it } from "vitest";
import { prose } from "../src/copy.ts";
import { foldLookalikes, LOOKALIKES } from "../src/lookalikes.ts";

/** Every [letter, what it reads as] pair of the table. */
const PAIRS = Object.entries(LOOKALIKES).flatMap(([ascii, letters]) => Array.from(letters, (letter) => [letter, ascii] as const));
const READS = new Map(PAIRS);
/** The keys that are punctuation, not A-Z letters: the apostrophe (A9b) and the click letters' punctuation (A9c). */
const PUNCTUATION = new Set(["'", "|", "||", "!"]);

describe("foldLookalikes (A9b, A9c)", () => {
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
    ["ĸ", "k"], // U+0138 kra: NamesList cross-refers it to U+1D0B small capital K
    ["ŋ", "n"], // U+014B eng: confusables.txt n + U+0329
    ["Ŋ", "N"], // U+014A: the other case of ŋ
    ["Ɓ", "B"], // U+0181 B with hook: its Unicode name
    ["Ɯ", "W"], // U+019C turned M, which reads as W (A9c)
    ["Ǝ", "E"], // U+018E reversed E (A9c)
    ["ǝ", "e"], // U+01DD turned e: the other case of Ǝ
  ])("reads the look-alike %j as %j", (letter, ascii) => {
    expect(foldLookalikes(letter)).toBe(ascii);
  });

  // A9c: the click letters look like punctuation, so they read as punctuation and never join two words into one.
  it.each([
    ["ǀ", "|"], // U+01C0 dental click, Unicode 1.0 name LATIN LETTER PIPE
    ["ǁ", "||"], // U+01C1 lateral click, LATIN LETTER DOUBLE PIPE
    ["ǃ", "!"], // U+01C3 retroflex click, LATIN LETTER EXCLAMATION MARK (confusables.txt: "!")
    ["ǂ", "ǂ"], // U+01C2 alveolar click: no confusables.txt entry and no A-Z letter, so it separates words as it is
  ])("reads the click letter %j as %j", (letter, punctuation) => {
    expect(foldLookalikes(letter)).toBe(punctuation);
  });

  it("keeps precomposed letters as typed and removes only the combining marks NFC leaves on their own (A9c)", () => {
    expect(foldLookalikes("Bjørn, Søren, Łukasz, Đorđe, Straße, Cœur d’Alene, Encyclopædia, Þórr, José, Señor, Crème, naïve, café")).toBe(
      "Bjorn, Soren, Lukasz, Dorde, Strasse, Coeur d’Alene, Encyclopaedia, THórr, José, Señor, Crème, naïve, café",
    );
    expect(foldLookalikes("Hawaiʻi, Oʻahu, Kāneʻohe, Mānoa, Kailua-Kona")).toBe("Hawai'i, O'ahu, Kāne'ohe, Mānoa, Kailua-Kona");
    expect(foldLookalikes("Tiệm Giặt Sấy, Saïd, Génération, bönd, décade, dollár")).toBe("Tiệm Giặt Sấy, Saïd, Génération, bönd, décade, dollár");
    expect(foldLookalikes("Tie\u0323\u0302m Sa\u0301y")).toBe("Tiệm Sáy"); // decomposed input composes first (NFC)
    expect(foldLookalikes("ǿ Ǿ ǽ Ǣ")).toBe("ǿ Ǿ ǽ Ǣ"); // precomposed, so read as typed, like é
    expect(foldLookalikes("Licen\u0336sed")).toBe("Licensed"); // U+0336 combining long stroke overlay
    expect(foldLookalikes("Licen\u20DDsed")).toBe("Licensed"); // U+20DD combining enclosing circle
    expect(foldLookalikes("Li\u0307censed")).toBe("Licensed"); // i + U+0307: no precomposed letter, and it draws as a plain i
    expect(foldLookalikes("Cert\u0335ified")).toBe("Certified"); // t + U+0335 short stroke overlay, hidden in the crossbar
    expect(foldLookalikes("e\u0301\u0336")).toBe("é"); // the acute composes; the overlay stays on its own and goes
  });

  it("leaves ASCII, punctuation and letters that look like no A-Z letter as they are", () => {
    const ascii = Array.from({ length: 0x80 }, (_, c) => String.fromCharCode(c)).join("");
    expect(foldLookalikes(ascii)).toBe(ascii);
    expect(foldLookalikes("Fast — friendly ’ “ ” ✨ Ɔ Ʃ Ʒ Ƽ ʔ")).toBe("Fast — friendly ’ “ ” ✨ Ɔ Ʃ Ʒ Ƽ ʔ");
  });

  it("lists only single letters that copy accepts and NFD leaves whole, each read as A-Z letters or punctuation", () => {
    for (const [letter, ascii] of PAIRS) {
      expect(letter, letter).toMatch(/^\p{L}$/u);
      expect(letter, letter).not.toMatch(/^[A-Za-z]$/);
      expect(letter.normalize("NFD"), letter).toBe(letter);
      expect(letter.normalize("NFKC"), letter).toBe(letter);
      expect(prose(80).safeParse(`Crew ${letter} team`).success, letter).toBe(true);
      expect(ascii, letter).toMatch(PUNCTUATION.has(ascii) ? /^[^A-Za-z0-9]+$/ : /^[A-Za-z]+$/);
    }
    expect(READS.size).toBe(PAIRS.length); // no letter listed twice
    expect(PAIRS).toHaveLength(128); // the A9b derivation, as changed by A9c (lookalikes.ts); a changed table must be derived again
  });

  it("reads a capital as capitals and any other letter as small letters", () => {
    for (const [letter, ascii] of PAIRS) {
      if (PUNCTUATION.has(ascii)) continue;
      expect(ascii, letter).toBe(/\p{Lu}/u.test(letter) ? ascii.toUpperCase() : ascii.toLowerCase());
    }
  });

  it("lists the other case of each letter too, as the same letters, when copy accepts it", () => {
    const missing: string[] = [];
    for (const [letter, ascii] of PAIRS) {
      for (const other of [letter.toUpperCase(), letter.toLowerCase()]) {
        if (other === letter || [...other].length !== 1 || /^[A-Za-z]$/.test(other)) continue;
        // Copy refuses e.g. ɓ, the small form of Ɓ (IPA), and Ƽ, the capital of ƽ, which looks like the digit 5 (A9c).
        if (!prose(80).safeParse(`Crew ${other} team`).success) continue;
        if (READS.get(other)?.toLowerCase() !== ascii.toLowerCase()) missing.push(`${letter} -> ${other}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
