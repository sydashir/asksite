import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prose } from "../src/copy.ts";
import { foldings, foldLookalikes, LOOKALIKES, SECOND_READINGS } from "../src/lookalikes.ts";

/** Every [letter, what it reads as] pair of the table. */
const PAIRS = Object.entries(LOOKALIKES).flatMap(([ascii, letters]) => Array.from(letters, (letter) => [letter, ascii] as const));
const READS = new Map(PAIRS);
/** The keys that are punctuation, not A-Z letters: the apostrophe (A9b) and the click letters' punctuation (A9c). */
const PUNCTUATION = new Set(["'", "|", "||", "!"]);

describe("foldLookalikes (A9b, A9c, A9e, A9f)", () => {
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

  // A9e: letters of the phonetic blocks copy now accepts, read as the A-Z letters confusables.txt 18.0.0 gives them (through
  // the letters the table reads: ə's prototype is ǝ), their names, the moderator's list and the other case of a listed letter.
  it.each([
    ["ə", "e"], // U+0259 schwa: confusables.txt prototype ǝ, which reads e
    ["Ə", "E"], // U+018F: the other case of ə
    ["ɑ", "a"], // U+0251 alpha (confusables.txt)
    ["Ɑ", "A"], // U+2C6D: the other case of ɑ
    ["ɡ", "g"], // U+0261 script g (confusables.txt)
    ["Ɡ", "G"], // U+A7AC capital script g
    ["ɩ", "i"], // U+0269 iota (confusables.txt)
    ["ɛ", "e"], // U+025B open e (the moderator's list; confusables.txt reads it as U+A793)
    ["Ɛ", "E"], // U+0190: the other case of ɛ
    ["\uA78C", "'"], // saltillo (confusables.txt)
    ["\uA78B", "'"], // capital saltillo
    ["ʋ", "v"], // U+028B: read like its capital Ʋ first, and as u too (confusables.txt; SECOND_READINGS, A9f)
    ["ꞵ", "b"], // U+A7B5 small beta: read like its capital Ꞵ first, and as ß (ss) too (confusables.txt; SECOND_READINGS, A9f)
    ["ɯ", "w"], // U+026F turned m, the small form of Ɯ
    ["ɱ", "m"], // U+0271 m with hook: confusables.txt's "rn" stands for m
    ["Ꝼ", "F"], // U+A77B insular F (letterform name)
    ["ꬶ", "g"], // U+AB36 script g with crossed-tail (named after ɡ)
    ["ꬼ", "n"], // U+AB3C eng with crossed-tail (named after ŋ)
    ["ꬳ", "e"], // U+AB33 barred e
    ["ꬰ", "a"], // U+AB30 barred alpha
    ["ʂ", "s"], // U+0282 s with hook
    ["ᶊ", "s"], // U+1D8A s with palatal hook
    ["ꝴ", "n"], // U+A774 NUM, an n with an abbreviation stroke
    ["ꞻ", "a"], // U+A7BB glottal a
    ["Ꜳ", "AA"], // U+A732 (confusables.txt)
    ["ʣ", "dz"], // U+02A3 dz digraph (confusables.txt)
    ["ꟾ", "i"], // U+A7FE I longa: named for I (a letter with no case reads small) first, and as confusables.txt's l too (A9f)
  ])("reads the letter %j that A9e lets into copy as %j", (letter, ascii) => {
    expect(foldLookalikes(letter)).toBe(ascii);
  });

  // A9f: letters A9e let into copy that draw like an A-Z letter although confusables.txt 18.0.0 gives them no A-Z
  // prototype (the moderator's A9f list, from the A9e review's WebKit render of the six theme font stacks), and the
  // letters the table's own rules then add.
  it.each([
    ["ꟽ", "w"], // U+A7FD epigraphic inverted M, which draws as W (NamesList.txt cross-refers it to Ɯ, which reads W)
    ["ɘ", "e"], // U+0258 reversed e
    ["ᴉ", "i"], // U+1D09 turned i
    ["ꟻ", "f"], // U+A7FB epigraphic reversed F
    ["ʊ", "u"], // U+028A upsilon
    ["Ʊ", "U"], // U+01B1: the other case of ʊ
    ["ᵿ", "u"], // U+1D7F upsilon with stroke: confusables.txt ʊ + U+0335, named after ʊ
  ])("reads the letter %j, which draws like an A-Z letter, as %j (A9f)", (letter, ascii) => {
    expect(foldLookalikes(letter)).toBe(ascii);
  });

  // A9f review round 1: more letters A9e let into copy that draw like an A-Z letter in the six theme font stacks
  // (Chromium and WebKit render) although confusables.txt 18.0.0 gives them no prototype, the letter named after one of
  // them, and the modifier letters that copy's NFKC turns into one of them.
  it.each([
    ["ʗ", "c"], // U+0297 stretched c
    ["ʘ", "o"], // U+0298 bilabial click, an O with a dot (a letter with no case reads small)
    ["Ꜧ", "H"], // U+A726 capital heng
    ["ꜧ", "h"], // U+A727 heng
    ["ɧ", "h"], // U+0267 heng with hook
    ["\u{1DF0F}", "c"], // STRETCHED C WITH CURL, named after ʗ
    ["\u{107B5}", "o"], // MODIFIER LETTER BILABIAL CLICK: copy's NFKC makes it ʘ first
    ["ꭜ", "h"], // MODIFIER LETTER SMALL HENG: NFKC makes it ꜧ
    ["\u{10797}", "h"], // MODIFIER LETTER SMALL HENG WITH HOOK: NFKC makes it ɧ
  ])("reads the letter %j, which draws like an A-Z letter, as %j (A9f round 1)", (letter, ascii) => {
    expect(foldLookalikes(letter.normalize("NFKC"))).toBe(ascii);
  });

  // A9f: ʋ, ꞵ and ꟾ read two ways, so a claim spelled with either reading is found. foldings() gives every combination:
  // the first reading (foldLookalikes), then each two-way letter in the text read its second way, alone and together.
  it("lists the letters that read two ways, each with its second reading", () => {
    expect(SECOND_READINGS).toEqual({ l: "ꟾ", ss: "ꞵ", u: "ʋ" });
  });

  it("reads each two-way letter a second way that differs from its first, and only the small letter, not its capital", () => {
    for (const [second, letters] of Object.entries(SECOND_READINGS)) {
      for (const letter of letters) {
        expect(READS.get(letter), letter).toBeDefined(); // the first reading is in LOOKALIKES
        expect(READS.get(letter), letter).not.toBe(second);
        expect(letter, letter).not.toMatch(/\p{Lu}/u);
        expect(second, letter).toMatch(/^[a-z]+$/);
      }
    }
    expect(foldings("Ʋ Ꞵ")).toEqual(["V B"]); // Ʋ reads V (its name) and Ꞵ reads B (confusables.txt): one way each
  });

  it("gives every combination of the two-way letters' readings, the first reading first", () => {
    expect(foldings("ꟾꞵʋ")).toEqual(["ibv", "lbv", "issv", "lssv", "ibu", "lbu", "issu", "lssu"]);
    expect(foldings("Fiʋe insʋred")).toEqual(["Five insvred", "Fiue insured"]); // a letter reads one way per reading
    expect(foldings("Licenꞵed crew")).toEqual(["Licenbed crew", "Licenssed crew"]);
    expect(foldings("cꟾock")).toEqual(["ciock", "clock"]);
  });

  it("gives one reading, the fold, when no two-way letter is in the text", () => {
    for (const text of ["", "plain words", "lıcensed", "Licen̶sed", "Ʋ", "Hawaiʻi"]) expect(foldings(text)).toEqual([foldLookalikes(text)]);
  });

  it("finds a two-way letter after its combining marks are removed", () => {
    expect(foldings("ʋ̶")).toEqual(["v", "u"]);
  });

  // A9g: ᴉ, ʗ, ʘ and Ʊ read as i, c, o and U, but they also draw as punctuation or a symbol ("!", "(", "⊙", "℧"). Read only
  // as a letter, one glued to a claim word joins it ("ƒreeᴉ" reads "freei"), so foldings() also reads the text with each
  // of them as a space, a word break (the A9f round-2 attack's measured fix), after the readings as letters.
  it("also reads ᴉ, ʗ, ʘ and Ʊ as a word break, after every reading as letters (A9g)", () => {
    expect(foldings("ƒreeᴉ")).toEqual(["freei", "free "]);
    expect(foldings("ʗƒree)")).toEqual(["cfree)", " free)"]);
    expect(foldings("ʘƒree")).toEqual(["ofree", " free"]);
    expect(foldings("ƱƑREE")).toEqual(["UFREE", " FREE"]);
    expect(foldings("Lᴉcensed")).toEqual(["Licensed", "L censed"]);
    expect(foldings("ᴉʗʘƱ")).toEqual(["icoU", "    "]);
    expect(foldings("insʋredᴉ")).toEqual(["insvredi", "insuredi", "insvred ", "insured "]); // and every two-way reading
    expect(foldings("ᴉ̶ƒree")).toEqual(["ifree", " free"]); // found after its combining marks are removed
  });

  it("gives no word-break reading for the letters that draw as letters (ʊ, ɘ, ꟻ, ꟽ, ɧ) (A9g)", () => {
    for (const text of ["ʊƀonded", "ɘlıcensed", "ꟻlıcensed", "ꟽƒree", "ɧƒree"]) expect(foldings(text)).toEqual([foldLookalikes(text)]);
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
    expect(foldLookalikes("ɐ ɔ ɹ ʌ ʃ ʇ")).toBe("ɐ ɔ ɹ ʌ ʃ ʇ"); // A9e: turned, open and Greek-derived letters the table does not list
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
    expect(PAIRS).toHaveLength(404); // the A9b derivation, as changed by A9c, A9e and A9f (lookalikes.ts); a changed table must be derived again
  });

  it("reads every letter as the derivation says: a digest of every letter and its reading, not only the count (A9d)", () => {
    // Moving a letter to another reading keeps the count (Ɵ read "Q" instead of "O"). A changed table must be derived
    // again (lookalikes.ts), and only then this digest updated.
    const table = PAIRS.map(([letter, reading]) => `U+${letter.codePointAt(0)?.toString(16).toUpperCase()} ${reading}`).sort();
    expect(createHash("sha256").update(table.join("\n")).digest("hex")).toBe("e7b21e048e096e7d72ea01b8fef67e69d553a77b7af777d6542bbee860098862");
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
        // Copy refuses e.g. ɓ, the small form of Ɓ (IPA).
        if (!prose(80).safeParse(`Crew ${other} team`).success) continue;
        if (READS.get(other)?.toLowerCase() !== ascii.toLowerCase()) missing.push(`${letter} -> ${other}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
