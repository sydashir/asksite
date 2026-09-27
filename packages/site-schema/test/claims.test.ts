import { describe, expect, it } from "vitest";
import { asReadOnPage } from "../src/claims.ts";
import {
  Facts,
  HIDDEN_IN_COPY,
  NEEDS_A_FACT,
  NEVER_IN_COPY,
  prose,
  proseIn,
  SiteDocument,
  unbackedClaims,
  type SiteDocumentInput,
} from "../src/index.ts";
import { foldLookalikes } from "../src/lookalikes.ts";

const base: SiteDocumentInput["facts"] = {
  businessName: "Mop",
  trade: "cleaning",
  phone: "+12085550107",
  email: "hi@example.com",
  location: { city: "Boise", state: "ID" },
  serviceArea: { places: ["Boise"] },
  services: [{ name: "House cleaning" }],
};

/** Every Unicode scalar value as a one-character string. */
const allCodePoints = (): string[] =>
  Array.from({ length: 0x110000 }, (_, c) => c)
    .filter((c) => c < 0xd800 || c > 0xdfff)
    .map((c) => String.fromCodePoint(c));

/** No licences, not insured, no 24/7, no free estimates, no founding year. */
const NONE = Facts.parse(base);
/** Every fact that can back a claim. */
const ALL = Facts.parse({
  ...base,
  licences: [{ label: "Idaho contractor", number: "RCE-1" }],
  insured: true,
  emergency247: true,
  freeEstimates: true,
});

describe("unbackedClaims", () => {
  it.each([
    "Licensed, bonded and fully insured",
    "Certified and BBB accredited",
    "Award-winning, top-rated, five-star service",
    "Highly rated by neighbors",
    "Real reviews from real neighbors",
    "“Best cleaners ever!” said Sarah",
    '"Best cleaners in Boise!" - Sarah K.',
    'Our customers call us "the best cleaners in Boise."',
    "‘Best cleaners ever!’ - Sarah",
    "Satisfaction guaranteed",
    "Every job comes with a warranty",
    "The lowest prices in town",
    "Only eighty-nine dollars",
    "Over twenty years of experience",
    "Serving Boise since the nineties",
    "A family business for three generations",
    "Same-day service",
    "Open weekends and Sundays",
    "Book online at mopboise.com",
  ])("never allows %j, whatever the facts", (text) => {
    expect(unbackedClaims(text, ALL)).not.toEqual([]);
  });

  it.each([
    ["Our licensed team", "licensed"],
    ["Fully insured for your peace of mind", "insured"],
    ["Emergency cleanups around the clock", "Emergency"],
    ["Call us any time, day or night", "any time"],
    ["Open seven days a week", "seven days a week"],
    ["seven-day-a-week service", "seven-day-a-week"],
    ["seven days per week", "seven days per week"],
    ["Here seven days each week", "seven days each week"],
    ["Seven days every week", "Seven days every week"],
    ["Open seven days of the week", "seven days of the week"],
    ["Help seven days/week", "seven days/week"],
    ["Help seven days / week", "seven days / week"],
    ["Get a free quote", "free"],
    ["There is no charge for a visit", "no charge"],
    ["A complimentary walkthrough", "complimentary"],
  ])("allows %j only when the owner's facts back it", (text, word) => {
    expect(unbackedClaims(text, NONE)).toEqual([word]);
    expect(unbackedClaims(text, ALL)).toEqual([]);
  });

  const ONLY = {
    licences: Facts.parse({ ...base, licences: [{ label: "Idaho contractor", number: "RCE-1" }] }),
    insured: Facts.parse({ ...base, insured: true }),
    emergency247: Facts.parse({ ...base, emergency247: true }),
    freeEstimates: Facts.parse({ ...base, freeEstimates: true }),
  };
  /** Every other backing fact set, but not this one: catches a checker that reads the wrong fact. */
  const ALL_BUT = {
    licences: Facts.parse({ ...base, insured: true, emergency247: true, freeEstimates: true }),
    insured: Facts.parse({ ...base, licences: [{ label: "Idaho contractor", number: "RCE-1" }], emergency247: true, freeEstimates: true }),
    emergency247: Facts.parse({ ...base, licences: [{ label: "Idaho contractor", number: "RCE-1" }], insured: true, freeEstimates: true }),
    freeEstimates: Facts.parse({ ...base, licences: [{ label: "Idaho contractor", number: "RCE-1" }], insured: true, emergency247: true }),
  };

  it.each([
    ["Our licensed team", "licensed", "licences"],
    ["Fully insured for your peace of mind", "insured", "insured"],
    ["Emergency cleanups around the clock", "Emergency", "emergency247"],
    ["Open seven days a week", "seven days a week", "emergency247"],
    ["seven-day-a-week service", "seven-day-a-week", "emergency247"],
    ["seven days per week", "seven days per week", "emergency247"],
    ["Here seven days each week", "seven days each week", "emergency247"],
    ["Open seven days of the week", "seven days of the week", "emergency247"],
    ["Help seven days/week", "seven days/week", "emergency247"],
    ["Get a free quote", "free", "freeEstimates"],
  ] as const)("allows %j when only its own fact (%s) is set, and rejects it when every other fact is set instead", (text, word, fact) => {
    expect(unbackedClaims(text, ONLY[fact])).toEqual([]);
    expect(unbackedClaims(text, ALL_BUT[fact])).toEqual([word]);
  });

  // A8c: opening hours that cover every day back the full-week phrase too, and nothing else.
  const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] as const;
  const EVERY_DAY_HOURS = {
    "one entry for all seven days": Facts.parse({ ...base, hours: [{ days: [...WEEKDAYS, "Saturday", "Sunday"], opens: "08:00", closes: "18:00" }] }),
    "three entries that cover the week": Facts.parse({
      ...base,
      hours: [
        { days: [...WEEKDAYS], opens: "07:00", closes: "19:00" },
        { days: ["Saturday"], opens: "08:00", closes: "14:00" },
        { days: ["Sunday"], opens: "10:00", closes: "12:00" },
      ],
    }),
  };
  const SIX_DAY_HOURS = Facts.parse({ ...base, hours: [{ days: [...WEEKDAYS, "Saturday"], opens: "08:00", closes: "18:00" }] });
  const WEEKLY = [
    "Open seven days a week",
    "seven-day-a-week service",
    "seven days per week",
    "Here seven days each week",
    "Open seven days of the week",
    "Help seven days/week",
  ];

  it.each(Object.entries(EVERY_DAY_HOURS))("allows the full-week phrase when the hours have %s", (_, facts) => {
    for (const text of WEEKLY) expect(unbackedClaims(text, facts)).toEqual([]);
  });

  it("still refuses the full-week phrase when the hours leave out a day", () => {
    expect(WEEKLY.map((text) => unbackedClaims(text, SIX_DAY_HOURS))).toEqual([
      ["seven days a week"],
      ["seven-day-a-week"],
      ["seven days per week"],
      ["seven days each week"],
      ["seven days of the week"],
      ["seven days/week"],
    ]);
  });

  it.each([
    ["Emergency cleanups around the clock", "Emergency"],
    ["We answer around the clock", "around the clock"],
    ["Call us any time, day or night", "any time"],
    ["Help day or night", "day or night"],
  ])("does not let hours for every day back %j (only a 24/7 fact does)", (text, word) => {
    for (const facts of Object.values(EVERY_DAY_HOURS)) expect(unbackedClaims(text, facts)).toEqual([word]);
  });

  it("refuses a sentence about how often, not opening hours, unless the facts back it (accepted residual)", () => {
    const text = "Water your new sod seven days a week for the first month";
    expect(unbackedClaims(text, NONE)).toEqual(["seven days a week"]);
    expect(unbackedClaims(text, EVERY_DAY_HOURS["one entry for all seven days"])).toEqual([]);
  });

  it("leaves ordinary sales copy alone", () => {
    expect(unbackedClaims("Careful cleaners for busy households. Hassle-free booking, one-off or weekly.", NONE)).toEqual([]);
  });

  it.each([
    "Most jobs take a few days",
    "Book a week ahead",
    "Seven rooms, one crew",
    "We can come two days a week or once a month",
    "Most paints need seven days to cure",
    "Your written quote arrives within seven days",
    "Give us seven days' notice",
    "Seven days of drying time",
    "a few days—a week for bigger jobs", // U+2014 em dash, which joins words in claims
    "Here for you every day", // left open by A8, A8b and A8c
    "Seven-day turnaround on most quotes", // why "seven-day service" stays uncaught (A8c)
    "Fast seven-day service", // known gap, recorded in A8c
    "Open seven days", // known gap, recorded in A8c-2: reads the same as the sentences below
    "We are open all seven days", // known gap, recorded in A8c-2
    "Keep the vents open seven days after painting", // A8c-2: the "open seven days" form refused these
    "Booking slots open seven days ahead",
    "Leave the windows open seven days so the plaster dries",
    "The trench stays open seven days at most",
    "Our quotes stay open seven days.",
    "We hold your booking open seven days while you decide.",
    "Leave the garage door open seven days while the epoxy cures.",
    "The new driveway can open seven days after paving.",
    "Bids open seven days before the deadline.",
    "Keep the vents open—seven days after painting—so the paint cures", // U+2014 em dash, a joiner
    "Book seven days ahead",
    "Leave the windows open. Seven days is enough to dry the plaster",
    "We reopen seven days after a storm",
  ])("does not read %j as a round-the-clock claim", (text) => {
    expect(unbackedClaims(text, NONE)).toEqual([]);
  });

  it.each([
    ["We answer around  the clock", "around the clock"], // doubled spaces: HTML shows one
    ["Same  day service", "Same day"],
    ["Five  star service", "Five star"],
    ["No  charge for a visit", "No charge"],
    ["Award  winning crew", "Award winning"],
    ["Call any  time", "any time"],
    ["We answer around\u00A0the clock", "around the clock"], // U+00A0 no-break space
    ["Open seven\u00A0days\u00A0a\u00A0week", "seven days a week"],
    ["Same\u2011day service", "Same-day"], // U+2011 non-breaking hyphen
    ["Five\u2010star service", "Five-star"], // U+2010 hyphen
    ["Help day\u2011or\u2011night", "day-or-night"], // U+2011 non-breaking hyphen
  ])("reads %j as the page shows it and finds %j", (text, claim) => {
    expect(unbackedClaims(text, NONE)).toEqual([claim]);
  });

  it.each([
    "Hassle-free booking",
    "Hassle\u2010free booking", // U+2010 hyphen (NFKC turns U+2011 into this)
    "Hassle\u2011free booking", // U+2011 non-breaking hyphen
  ])("does not read the free in %j as a free offer", (text) => {
    expect(unbackedClaims(text, NONE)).toEqual([]);
  });

  it.each([
    "Estimates\u2014free", // U+2014 em dash
    "Estimates\u2013free", // U+2013 en dash
  ])("still reads free after a dash in %j", (text) => {
    expect(unbackedClaims(text, NONE)).toEqual(["free"]);
  });

  const DASHES = ["\u2013", "\u2014", "\u2012", "\u2212"]; // en dash, em dash, figure dash, minus sign

  it.each(DASHES.flatMap((d) => ["Same" + d + "day service", "Five" + d + "star service", "Award" + d + "winning crew", "Next" + d + "day repairs"]))(
    "never allows a multi-word claim joined by a dash character: %j",
    (text) => {
      expect(unbackedClaims(text, ALL)).not.toEqual([]);
    },
  );

  it.each(DASHES.flatMap((d) => ["Round" + d + "the" + d + "clock help", "No" + d + "charge visit"]))(
    "allows a dash-joined multi-word claim only when the owner's facts back it: %j",
    (text) => {
      expect(unbackedClaims(text, NONE).length).toBeGreaterThan(0);
      expect(unbackedClaims(text, ALL)).toEqual([]);
    },
  );

  it.each(["-", ...DASHES].flatMap((d) => ["day" + d + "or" + d + "night", "any" + d + "time", "seven" + d + "days" + d + "a" + d + "week", "seven" + d + "days" + d + "of" + d + "the" + d + "week"]))(
    "allows the emergency claim %j, joined by a hyphen or dash, only when the owner's facts back it",
    (claim) => {
      const text = "Call us " + claim + " for a burst pipe";
      expect(unbackedClaims(text, NONE)).toEqual([claim]);
      expect(unbackedClaims(text, ALL)).toEqual([]);
    },
  );

  // A8c: every other dash reads like an em dash. These 16 survive NFKC (so they reach the checker in
  // AI copy) and are not in the joiner list above; the rest of \p{Pd} is added from the engine's tables.
  const OTHER_DASHES = [
    "―", "⁃", "⎯", "─", "━", "⸗", "⸚", "⸺",
    "⸻", "⹀", "⹝", "〜", "〰", "゠", "ー", "ｰ",
  ];
  const JOINERS = new Set(["-", "‐", "‑", ...DASHES]); // U+2010/U+2011 read as "-" (A2)
  const EVERY_OTHER_DASH = [...new Set([...OTHER_DASHES, ...allCodePoints().filter((c) => /\p{Pd}/u.test(c))])].filter((d) => !JOINERS.has(d));

  it("finds \"Award―winning\" (U+2015 horizontal bar) whatever the facts", () => {
    expect(unbackedClaims("Award―winning crew", ALL)).toEqual(["Award—winning"]);
  });

  it("covers the listed dashes and every \\p{Pd} this engine knows", () => {
    expect(EVERY_OTHER_DASH).toEqual(expect.arrayContaining([...OTHER_DASHES, "֊", "־", "᐀", "᠆", "\u{10EAD}"]));
    expect(EVERY_OTHER_DASH.length).toBeGreaterThanOrEqual(OTHER_DASHES.length + 5);
  });

  const TEMPLATES = [
    (d: string) => `Award${d}winning crew`,
    (d: string) => `Same${d}day service`,
    (d: string) => `Round${d}the${d}clock help`,
    (d: string) => `Call us seven${d}days${d}a${d}week`,
    (d: string) => `No${d}charge visit`,
    (d: string) => `Estimates${d}free`,
    (d: string) => `Hassle${d}free booking`,
    (d: string) => `a few days${d}a week for bigger jobs`,
    (d: string) => `Most jobs take a few days ${d} rarely more`,
  ];

  it.each(EVERY_OTHER_DASH.map((d) => [`U+${d.codePointAt(0)?.toString(16).toUpperCase()}`, d]))(
    "reads %s exactly as an em dash, with and without backing facts",
    (_, d) => {
      for (const template of TEMPLATES) {
        for (const facts of [NONE, ALL]) {
          expect(unbackedClaims(template(d), facts)).toEqual(unbackedClaims(template("—"), facts));
        }
      }
    },
  );

  // A9, A9c: claims are also matched with every combining mark removed that NFC leaves on its own (one that is not
  // part of a precomposed letter), so an overlay or enclosing mark inside a word or between two words hides no claim.
  it.each([
    ["Licen\u0336sed crew", "Licensed"], // U+0336 combining long stroke overlay inside the word
    ["Licen\u20DDsed crew", "Licensed"], // U+20DD combining enclosing circle (an enclosing mark, Me)
    ["Licen\u{1D165}sed crew", "Licensed"], // U+1D165 musical symbol combining stem (a spacing mark, Mc)
    ["Li\u0307censed crew", "Licensed"], // i + U+0307: no precomposed letter, and the dot merges with the i's own
    ["Fully insu\u0335red", "insured"], // u + U+0335 combining short stroke overlay
    ["Get a f\u0335ree quote", "free"], // f + U+0335, hidden in the f's crossbar
  ])("reads %j with its leftover marks removed and finds %j unless the facts back it", (text, word) => {
    expect(unbackedClaims(text, NONE)).toEqual([word]);
    expect(unbackedClaims(text, ALL)).toEqual([]);
  });

  // A9c accepted residual: a precomposed accented letter is read as typed, so real words keep their meaning ("Saïd",
  // "Tiệm Giặt Sấy") and a deliberately accented claim word is not caught, as before A9. The approval screen is the backstop.
  it.each([
    "Our lícensed team", // U+00ED i with acute
    "Our li\u0301censed team", // i + U+0301, which NFC composes into í
    "Fully i\u0308nsured",
    "Get a frée quote",
    "Fïve-stär service",
    "Satisfaction guaránteed",
    "Bǿnded crew", // U+01FF, ø with acute, is precomposed too
  ])("does not read the precomposed accented letters in %j as A-Z letters (accepted residual)", (text) => {
    expect(unbackedClaims(text, NONE)).toEqual([]);
  });

  it.each([
    ["Award \u0336winning crew", "Award winning"], // A8c-3: U+0336 splits the claim from the space
    ["Same \u0336day help", "Same day"],
    ["Award\u0336 winning crew", "Award winning"],
    ["Cert\u0335ified pros", "Certified"], // t + U+0335, hidden in the t's crossbar
    ["Top-rat\u0335ed crew", "Top-rated"],
  ])("never allows %j (%j once its leftover marks are removed), whatever the facts", (text, claim) => {
    expect(unbackedClaims(text, NONE)).toEqual([claim]);
    expect(unbackedClaims(text, ALL)).toEqual([claim]);
  });

  it.each([
    "Café-clean kitchens, naïve questions welcome",
    "Jalapeño stains lifted",
    "Crème brûlée spills, gone",
    // A9c: precomposed letters are read as typed, so these real names and words are not claims
    "Tiệm Giặt Sấy washes your quilts",
    "Giặt Sấy Laundry",
    "Ask for Saïd",
    "Génération Nouvelle Bakery",
    "Icelandic bönd",
    "A décade of ten days",
    "Priced in dollár? No, in forint",
  ])("leaves ordinary accented copy alone: %j", (text) => {
    expect(unbackedClaims(text, NONE)).toEqual([]);
  });

  // A9b: a Latin letter with no A-Z base letter that looks like one ("ı", "ƒ", "Ł", capital iota) is read
  // as the A-Z letters it looks like (lookalikes.ts), so it hides no claim either.
  it.each([
    ["Our lıcensed team", "licensed"], // U+0131 dotless i
    ["Get a ƒree quote", "free"], // U+0192 f with hook
    ["Łicensed plumbers", "Licensed"], // U+0141 L with stroke
    ["ŁICENSED PLUMBERS", "LICENSED"],
    ["FULLY ƗNSURED", "INSURED"], // U+0197 capital I with stroke
    ["FULLY ƖNSURED", "INSURED"], // U+0196 capital iota
    ["ƑREE ESTIMATES", "FREE"], // U+0191 capital F with hook
    ["ƎMERGENCY CALLS", "EMERGENCY"], // U+018E reversed E (A9c)
    ["Fully licǝnsǝd", "licensed"], // U+01DD turned e, the other case of Ǝ
    ["Get a frǝǝ quote", "free"],
    ["Fully ınsuređ", "insured"],
    ["Help around þe clock", "around the clock"], // þ reads "th"
    ["Help day or ŋight", "day or night"], // U+014B eng
    ["There is ŋo charge", "no charge"],
    // A9e: letters of the phonetic blocks, which copy now accepts
    ["Fully licənsəd", "licensed"], // U+0259 schwa
    ["ƐMERGENCY CALLS", "EMERGENCY"], // U+0190 open E (a residual until A9e)
    ["Get a frɛɛ quote", "free"], // U+025B open e
    ["Licenʂed plumbers", "Licensed"], // U+0282 s with hook
    ["Licenᶊed crew", "Licensed"], // U+1D8A s with palatal hook
    ["Ꝼree quotes", "Free"], // U+A77B insular F
    ["Fully licꬳnsꬳd", "licensed"], // U+AB33 barred e
    ["There is ꬼo charge", "no charge"], // U+AB3C eng with crossed-tail
    ["Fully \u{1DF1A}nsured", "insured"], // i with stroke and retroflex hook (Latin Extended-G)
    ["Emerɡency plumbing", "Emergency"], // U+0261 script g
    ["Call ɑnytime", "anytime"], // U+0251 alpha
    ["Help day or ꝴight", "day or night"], // U+A774 NUM, an n with a stroke
  ])("reads the look-alike letters in %j as A-Z and finds %j unless the facts back it", (text, word) => {
    expect(unbackedClaims(text, NONE)).toEqual([word]);
    expect(unbackedClaims(text, ALL)).toEqual([]);
  });

  it.each([
    ["ƁONDED CREW", "BONDED"], // U+0181 capital B with hook
    ["Bøndéd crew", "Bond"], // ø reads o; é stays as typed (A9c), and "Bond" before it is a word
    ["ƜARRANTY INCLUDED", "WARRANTY"], // U+019C turned M reads W (A9c)
    ["Certifieđ technicians", "Certified"],
    ["Top-ɍated crew", "Top-rated"], // U+024D r with stroke
    ["Ƒive-star service", "Five-star"],
    // A9e
    ["ꬶuaranteed results", "guaranteed"], // U+AB36 script g with crossed-tail
    ["Our guarꬰntee", "guarantee"], // U+AB30 barred alpha
    ["ɑward-winning crew", "award-winning"], // U+0251 alpha
    ["Ꞵonded crew", "Bonded"], // U+A7B4 capital beta (confusables.txt: B)
    ["ƔEARS OF CARE", "YEARS"], // U+0194 capital gamma, the other case of ɣ (confusables.txt: y)
  ])("never allows %j (%j once read as A-Z), whatever the facts", (text, claim) => {
    expect(unbackedClaims(text, NONE)).toEqual([claim]);
    expect(unbackedClaims(text, ALL)).toEqual([claim]);
  });

  // A9f: ʋ (v or u), ꞵ (b or ß, read "ss") and ꟾ (i or l) read both ways, each two-way letter independently of the
  // others; and ꟽ ɘ ᴉ ꟻ ʊ (with Ʊ and ᵿ) read as the A-Z letter they draw like. The attacks are from the A9e review rounds.
  it.each([
    ["Fully insʋred", "insured"], // ʋ read u
    ["Aroʋnd the clock help", "Around the clock"],
    ["Licenꞵed plumbers", "Licenssed"], // ꞵ read ß, which reads "ss"
    ["Around the cꟾock service", "Around the clock"], // ꟾ read l
    ["Lꟾcensed crew", "Licensed"], // ꟾ read i
    ["ꟾicensed crew", "licensed"],
    ["Fully ꟾnsʋred", "insured"], // ꟾ read i and ʋ read u in one word: each two-way letter reads both ways on its own
    ["Fully insʊred", "insured"], // U+028A upsilon
    ["FULLY INSƱRED", "INSURED"], // U+01B1, the other case of ʊ
    ["Fully insᵿred", "insured"], // U+1D7F upsilon with stroke
    ["Lᴉcensed crew", "Licensed"], // U+1D09 turned i
    ["Fully licɘnsɘd", "licensed"], // U+0258 reversed e
    ["ꟻREE ESTIMATES", "fREE"], // U+A7FB reversed F, a letter with no case, reads a small f
    ["Get a ꟻree quote", "free"],
  ])("reads the look-alike letters in %j as A-Z and finds %j unless the facts back it (A9f)", (text, word) => {
    expect(unbackedClaims(text, NONE)).toEqual([word]);
    expect(unbackedClaims(text, ALL)).toEqual([]);
  });

  it.each([
    ["Fiʋe-star service", "Five-star"], // ʋ read v
    ["Satisfaction gʋaranteed", "guaranteed"], // ʋ read u
    ["Over a hʋndred homes", "hundred"],
    ["ꞵonded crew", "bonded"], // ꞵ read b
    ["Save doꟾlars today", "dollars"], // ꟾ read l
    ["Miꟾlions served", "Millions"],
    ["Estabꟾished crew", "Established"],
    ["ꟽARRANTY INCLUDED", "wARRANTY"], // U+A7FD inverted M reads a small w
    ["Open ꟽeekends", "weekends"],
    ["Eʋe crews since the start", "since"], // found as typed; the two-way letter in the name reads no claim either way
  ])("never allows %j (%j once read as A-Z), whatever the facts (A9f)", (text, claim) => {
    expect(unbackedClaims(text, NONE)).toEqual([claim]);
    expect(unbackedClaims(text, ALL)).toEqual([claim]);
  });

  it.each([
    "Serving Hawaiʻi, Oʻahu and Kāneʻohe",
    "Serving Hawaiʼi and Oʼahu",
    "Homes in Mānoa and Kailua-Kona",
    "Ask for Bjørn, Søren, Łukasz or Đorđe",
    "From Straße to Cœur d’Alene",
    "Encyclopædia-level know-how",
    "José, Señor, Crème and a naïve café owner",
    "Þórr runs the crew",
    // A9e: letters of the phonetic blocks in real names and places (English Wikipedia titles; USGS GNIS)
    "Serving homes near Wewətanagok",
    "Ayşən Əbdüləzimova and Aşiq Ələsgər",
    "Chevak Cupꞌik dialect",
    "Ofon Na Ɛdi Asɛm Fo",
    "Oberi Ɔkaimɛ",
    "Eʋe and Kʋsaal",
    "Agraw Imaziɣen",
    "Fulɓe and Gaɗi language",
  ])("finds no claim in real place names and people's names: %j", (text) => {
    expect(unbackedClaims(text, NONE)).toEqual([]);
  });

  // A9b round 1: the fold can join two words the page shows apart. It reads U+01C0 ǀ (Unicode 1.0 name "LATIN
  // LETTER PIPE", like "|") and U+01C1 ǁ as letters, and it removes a combining mark used between two words.
  // So claims are also matched as typed, as main (acae4ab) matched them: the fold only ever adds a claim.
  it.each([
    ["ǀBondedǀ", ["Bonded"], ["Bonded"]],
    ["ǀCertifiedǀ pros", ["Certified"], ["Certified"]],
    ["ǀTop-ratedǀ", ["Top-rated"], ["Top-rated"]],
    ["Trusted ǀsinceǀ the start", ["since"], ["since"]],
    ["Open ǀweekendsǀ", ["weekends"], ["weekends"]],
    ["Ratedǁbonded", ["bonded", "Rated"], ["bonded", "Rated"]], // U+01C1
    ["Get a ǀfreeǀ quote", ["free"], []],
    ["Our ǀlicensed team", ["licensed"], []],
    ["Fully ǀinsured", ["insured"], []],
    ["Call ǀanytime", ["anytime"], []],
    ["ǁfreeǁ quote", ["free"], []],
    ["Freeǀrated", ["rated", "Free"], ["rated"]],
    ["LicensedǀInsuredǀBonded", ["Bonded", "Licensed", "Insured"], ["Bonded"]], // the fold alone read "LicensedlInsuredlBonded"
    ["|Bonded|", ["Bonded"], ["Bonded"]], // ASCII | for comparison: the same at every commit
    ["Free|rated", ["rated", "Free"], ["rated"]],
    ["Top\u0336rated", ["rated"], ["rated"]], // U+0336 combining long stroke overlay (Mn)
    ["Bonded\u20DDcrew", ["Bonded"], ["Bonded"]], // U+20DD combining enclosing circle (Me)
    ["Free\u20E3quote", ["Free"], []], // U+20E3 combining enclosing keycap (Me)
    ["Certified\u{1D165}pros", ["Certified"], ["Certified"]], // U+1D165 musical symbol combining stem (Mc)
    ["Certifiedé crew", ["Certified"], ["Certified"]], // é (U+00E9) is not an A-Z letter, so a word ends before it (NFC keeps it, A9c)
    // A word is shown as typed when the typed reading finds it, so the owner can find it in the copy: here as
    // main showed it, although the folded reading is "guaranteed".
    ["Satisfaction guaranteeđ", ["guarantee"], ["guarantee"]],
  ])("also reads %j as typed, finding %j without facts and %j with every fact", (text, withoutFacts, withAllFacts) => {
    expect(unbackedClaims(text, NONE)).toEqual(withoutFacts);
    expect(unbackedClaims(text, ALL)).toEqual(withAllFacts);
  });

  // A9c: the click letters U+01C0-01C3 look like | ‖ ǂ ! and act as punctuation in claim matching, never as letters. So
  // a mark hidden inside the word they wrap (i + U+0307 draws as a plain i) is removed and the word is found.
  it.each([
    ["ǀCerti\u0307fiedǀ pros", ["Certified"], ["Certified"]],
    ["ǀLi\u0307censedǀ plumbers", ["Licensed"], []],
    ["Trusted ǀsi\u0307nceǀ the start", ["since"], ["since"]],
    ["Call ǀanyti\u0307meǀ", ["anytime"], []],
    ["ǁbondi\u0307ngǁ", [], []], // not a claim word: "bond" is followed by more letters
    ["ǂBondedǂ", ["Bonded"], ["Bonded"]],
    ["ǃBondedǃ", ["Bonded"], ["Bonded"]],
    ["Freeǂrated", ["rated", "Free"], ["rated"]],
    ["ǃfreeǃ quote", ["free"], []],
  ])("reads the click letters in %j as punctuation, finding %j without facts and %j with every fact", (text, withoutFacts, withAllFacts) => {
    expect(unbackedClaims(text, NONE)).toEqual(withoutFacts);
    expect(unbackedClaims(text, ALL)).toEqual(withAllFacts);
  });

  // A9d: a CamelCase word is read as typed, as at main (acae4ab), so a real name that runs a claim word into another
  // word is no claim. A9c's CamelCase reading refused these names and was dropped; CamelCase claim words ("TopRated")
  // are not caught (design §2.2, "Not caught").
  it.each([
    "Serving homes near McMillion Creek", // GNIS 1552041 (West Virginia)
    "FreeFlow Plumbing",
    "BondTech Roofing",
    "StreakFree Window Cleaning",
    "PSEG WorryFree service",
    "HassleFree booking",
    "Ask for McDonald or DeShawn",
    "Serving DeKalb, LaGrange and McAllen",
    "Serving homes near dukMéʔem wáťa", // GNIS 260516, with U+0294 ʔ
    "Book from your iPhone",
    "Find our videos on YouTube",
  ])("finds no claim in a CamelCase name, which it reads as typed: %j", (text) => {
    expect(unbackedClaims(text, NONE)).toEqual([]);
  });

  it("finds every claim main's reading finds, word for word, whatever character the fold changes is glued to it", () => {
    // Every character copy accepts that the fold changes: a combining mark it removes, a character NFC replaces, or
    // a look-alike it reads as A-Z letters or punctuation. The fold works one character at a time, so every other character
    // reads the same both ways. The first two filters only save time: copy refuses unassigned and private-use
    // code points and every script but Latin, Common and Inherited.
    const folded = allCodePoints().filter(
      (c) =>
        !/[\p{Cn}\p{Co}]/u.test(c) &&
        /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]+$/u.test(c.normalize("NFKC")) &&
        foldLookalikes(c) !== c &&
        prose(80).safeParse(`a${c}a`).success,
    );
    expect(folded).toEqual(expect.arrayContaining(["ǀ", "ǁ", "ǃ", "\u0336", "\u0307", "\u20DD", "\u20E3", "\u{1D165}", "ı", "ƒ", "Ł", "ʻ", "Ǝ", "Ɯ"]));
    expect(folded).not.toContain("é"); // precomposed: read as typed (A9c)

    const patterns = [...NEVER_IN_COPY, ...NEEDS_A_FACT.map(({ pattern }) => pattern)];
    /** The claims main (acae4ab) found: every pattern run on the text as the page shows it, without the fold. */
    const mainClaims = (text: string): string[] => {
      const page = asReadOnPage(text);
      return patterns.flatMap((pattern) => pattern.exec(page)?.[0] ?? []);
    };
    // One claim of every pattern, glued on either side, before a word and after a word.
    const claims = ["bonded", "certified", "rated", "top-rated", "reviews", '"great"', "guaranteed", "cheapest", "thousands", "since", "same-day", "weekends", "mopboise.com", "licensed", "insured", "anytime", "seven days a week", "free", "no charge", "complimentary"];
    const missed: string[] = [];
    for (const c of folded) {
      for (const claim of claims) {
        for (const text of [`${c}${claim}${c}`, `${claim}${c}crew`, `Our${c}${claim}`]) {
          const found = unbackedClaims(text, NONE);
          for (const word of mainClaims(text)) if (!found.includes(word)) missed.push(`${JSON.stringify(text)} misses ${JSON.stringify(word)}`);
        }
      }
    }
    expect(missed).toEqual([]);
  });

  it.each([
    'A lone " mark',
    '" autofocus onfocus="alert(document.cookie)', // attribute breakouts the renderer must escape (Task 15's XSS fixture)
    '<iframe srcdoc="<script>alert(document.domain)</script>"></iframe>',
  ])("does not read a straight quote that opens no quoted phrase as a testimonial: %j", (text) => {
    expect(unbackedClaims(text, NONE)).toEqual([]);
  });

  it("walks every prose string except the repeated service names", () => {
    const copy = SiteDocument.parse(MINIMAL_DOC).copy;
    expect(proseIn(copy).map(([path]) => path.join("."))).toEqual([
      "heroHeadline",
      "heroSubheadline",
      "ctaText",
      "sectionIntros.faq",
      "serviceDescriptions.0.description",
      "faq.0.question",
      "faq.0.answer",
    ]);
  });
});

describe("HIDDEN_IN_COPY", () => {
  it.each([
    "Licen\u034Fsed and insu\u034Fred", // U+034F combining grapheme joiner splits "Licensed"/"insured"
    "Bon\uFE0Fded crew", // U+FE0F variation selector splits "Bonded"
    "Satisfaction guaran\uFE00teed", // U+FE00 variation selector splits "guaranteed"
    "Friendly \u034F team", // U+034F on its own between spaces
    "Warm welcome \u2764\uFE00", // U+FE00 is not an emoji presentation selector
    "Leak fixed \u2714\uFE0F\uFE0F", // a second U+FE0F follows a selector, not an emoji
  ])("matches %j", (text) => {
    expect(HIDDEN_IN_COPY.test(text)).toBe(true);
  });

  it("does not match plain Latin prose", () => {
    expect(HIDDEN_IN_COPY.test("Licensed and insured, friendly local team.")).toBe(false);
  });

  it.each([
    "Leak fixed \u2714\uFE0F", // U+FE0F after an emoji selects its colour form
    "Friendly team \u2764\uFE0F",
    "Cool comfort \u2744\uFE0F",
    "Tidy work \u2714\uFE0E", // U+FE0E after an emoji selects its text form
    "Press #\uFE0F\u20E3", // keycap sequence
  ])("does not match an emoji's presentation selector: %j", (text) => {
    expect(HIDDEN_IN_COPY.test(text)).toBe(false);
  });
});

const MINIMAL_DOC: SiteDocumentInput = {
  facts: base,
  copy: {
    heroHeadline: "Clean homes",
    heroSubheadline: "Careful cleaners for busy Boise households.",
    ctaText: "Book",
    sectionIntros: { faq: "Quick answers." },
    serviceDescriptions: [{ service: "House cleaning", description: "Weekly or one-off." }],
    faq: [{ question: "Do you bring supplies?", answer: "Yes, everything we need." }],
  },
  layout: [
    { id: "hero", variant: "centered" },
    { id: "services", variant: "cards" },
    { id: "serviceArea", variant: "split" },
    { id: "faq", variant: "accordion" },
    { id: "contact", variant: "card" },
  ],
  theme: { palette: "green-amber", font: "clean" },
};

describe("SiteDocument rejects AI copy that states facts the owner did not give", () => {
  it.each([
    "Licensed, bonded and fully insured",
    "Over twenty years",
    "Only eighty-nine dollars",
    "Call ２０８ ５５５ ０１０７",
    "Just ＄８９",
    "Visit mopboise.com",
    "Emergency cleaning around the clock",
    "Reliable day-or-night plumbing across Boise.",
    "Call us any-time for a clogged drain.",
    "Open seven days a week",
    "Free estimates, no hidden fees",
    "Five-star rated, award-winning, BBB accredited",
    "Award―winning crew", // U+2015 horizontal bar survives NFKC
    "“Best cleaners ever!” said Sarah",
    '"Best cleaners in Boise!" - Sarah K.',
    "‘Best cleaners ever!’ - Sarah",
    "Satisfaction guaranteed",
    "Friendly \u034F team",
    "Award \u0336winning crew", // A8c-3: a combining mark splits the claim (A9 folds it away)
    "Same \u0336day help",
    "L\u0131censed and \u0131nsured plumbers", // U+0131 dotless i (A9b: read as "i", so a claim)
    "\u029F\u026A\u1D04\u1D07\u0274\uA731\u1D07\u1D05 \u1D00\u0274\u1D05 \u026A\u0274\uA731\u1D1C\u0280\u1D07\u1D05 plumbers", // small capitals (refused by Copy)
    "Licen\u0282ed plumbers", // U+0282 s with hook (IPA Extensions; A9e: Copy accepts it and the claim checker reads "Licensed")
    "Get a \u0192ree quote", // A9b: U+0192 f with hook reads "free"
    "\u0141ICENSED PLUMBERS", // A9b: U+0141 reads "L"
    "FULLY \u0196NSURED", // A9b: U+0196 capital iota reads "I"
    "\u026Ansured plumbers", // U+026A small capital I (refused by Copy)
    "\u1D04ertified crew", // U+1D04 small capital C (refused by Copy)
    "\u01C0Bonded\u01C0", // A9b round 1: U+01C0 reads "l" once folded but shows like "|", so "Bonded" is a claim as typed
    "Get a \u01C0free\u01C0 quote",
    "Top\u0336rated crew", // A9b round 1: U+0336 between the words, which the fold removes
    "Certified\u{1D165}pros",
    "Call (ƧOȢ) ƼƼƼ-OlƧƷ", // A9c: letters that look like digits (refused by Copy)
    "Call (ƨƽƽ) ƽƽƽ-Olƨȝ today.", // A9c review: their small forms draw the same digits
    "Save \u1EFCO% on drain cleaning.", // A9d: U+1EFC MIDDLE-WELSH V draws as a 6 (refused by Copy)
    "ꬶuaranteed results", // A9c: Latin Extended-E (A9e: Copy accepts it and the claim checker reads "guaranteed")
    "Ꝼree quotes", // A9e: U+A77B insular F reads F
    "Save \uA72DO% on drain cleaning.", // A9e: U+A72D cuatrillo draws as a 4 (refused by Copy)
    "\u01C0Certi\u0307fied\u01C0 pros", // A9c: a click letter reads as "|", and the leftover U+0307 goes
    "\u019CARRANTY INCLUDED", // A9c: U+019C reads W
    "Fully ins\u028Bred plumbers", // A9f: U+028B ʋ reads u as well as v
    "Licen\uA7B5ed plumbers", // A9f: U+A7B5 ꞵ reads ß (ss) as well as b
    "Help around the c\uA7FEock", // A9f: U+A7FE ꟾ reads l as well as i
    "\uA7FDARRANTY INCLUDED", // A9f: U+A7FD ꟽ reads w
    "Fully ins\u028Ared plumbers", // A9f: U+028A ʊ reads u
    "Save \uA78DO% on drain cleaning.", // A9f: U+A78D Ɥ draws like an open 4 (refused by Copy)
  ])("%j", (claim) => {
    const faq = [{ question: "Why us?", answer: claim }];
    const result = SiteDocument.safeParse({ ...MINIMAL_DOC, copy: { ...MINIMAL_DOC.copy, faq } });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toEqual(["copy.faq.0.answer"]);
  });

  // An invisible mark inside a claim word is refused as invisible, and (A9) the claim it splits is
  // still found, because claims are matched with every combining mark removed.
  it.each([
    ["Licen\u034Fsed and insu\u034Fred", ['"Licensed"', '"insured"']],
    ["Bon\uFE0Fded crew", ['"Bonded"']],
    ["Satisfaction guaran\uFE00teed", ['"guaranteed"']],
  ])("%j is refused as invisible and as the claim %j", (text, claims) => {
    const faq = [{ question: "Why us?", answer: text }];
    const result = SiteDocument.safeParse({ ...MINIMAL_DOC, copy: { ...MINIMAL_DOC.copy, faq } });
    expect(result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([
      "copy.faq.0.answer: Copy must not contain an invisible character",
      `copy.faq.0.answer: Copy states something the owner's facts do not back: ${claims.join(", ")}`,
    ]);
  });

  it("checks copy as the page shows it and keeps the copy as written", () => {
    const faq = [{ question: "Why us?", answer: "There is no  charge for a visit" }]; // HTML shows one space
    const doc = { ...MINIMAL_DOC, copy: { ...MINIMAL_DOC.copy, faq } };
    const result = SiteDocument.safeParse(doc);
    expect(result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([
      `copy.faq.0.answer: Copy states something the owner's facts do not back: "no charge"`,
    ]);
    const backed = SiteDocument.parse({ ...doc, facts: { ...base, freeEstimates: true } });
    expect(backed.copy.faq[0]?.answer).toBe("There is no  charge for a visit");
  });

  it('refuses the never-allowed claim in "LicensedǀInsuredǀCerti\u0307fied" even when every fact is set (A9c)', () => {
    const facts = { ...base, licences: [{ label: "Idaho contractor", number: "RCE-1" }], insured: true, emergency247: true, freeEstimates: true };
    const faq = [{ question: "Why us?", answer: "Licensed\u01C0Insured\u01C0Certi\u0307fied" }];
    const layout = [...MINIMAL_DOC.layout, { id: "trust", variant: "band" } as const];
    const result = SiteDocument.safeParse({ ...MINIMAL_DOC, facts, layout, copy: { ...MINIMAL_DOC.copy, faq } });
    expect(result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([
      `copy.faq.0.answer: Copy states something the owner's facts do not back: "Certified"`,
    ]);
  });

  it('refuses the bond claim in "LicensedǀInsuredǀBonded" even when every fact is set (A9b round 1)', () => {
    const facts = { ...base, licences: [{ label: "Idaho contractor", number: "RCE-1" }], insured: true, emergency247: true, freeEstimates: true };
    const faq = [{ question: "Why us?", answer: "LicensedǀInsuredǀBonded" }];
    const layout = [...MINIMAL_DOC.layout, { id: "trust", variant: "band" } as const];
    const result = SiteDocument.safeParse({ ...MINIMAL_DOC, facts, layout, copy: { ...MINIMAL_DOC.copy, faq } });
    expect(result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([
      `copy.faq.0.answer: Copy states something the owner's facts do not back: "Bonded"`,
    ]);
  });
});

describe("SiteDocument keeps AI copy the checks have no reason to reject", () => {
  it.each([
    "Leak fixed \u2714\uFE0F", // Copy accepts emoji (copy.test.ts), so a whole page must too
    "Friendly team \u2764\uFE0F",
    "Cool comfort \u2744\uFE0F",
    "Keep the vents open seven days after painting.", // A8c-2: not a claim about opening hours
    '" autofocus onfocus="alert(document.cookie)', // Task 15's XSS fixture puts these in AI copy
    '<iframe srcdoc="<script>alert(document.domain)</script>"></iframe>',
    "Café-clean kitchens, naïve questions welcome", // A9: accents on A-Z letters are fine
    "Jalapeño stains lifted",
    "Cafe\u0301-clean kitchens", // e + U+0301 combining acute
    "Serving Hawai\u02BBi, O\u02BBahu and K\u0101ne\u02BBohe", // A9b: U+02BB, the ʻokina
    "Homes in M\u0101noa and Kailua-Kona",
    "Ask for Bj\u00F8rn, S\u00F8ren, \u0141ukasz or \u0110or\u0111e", // A9b: letters that are not A-Z with an accent
    "From Stra\u00DFe to C\u0153ur d\u2019Alene",
    "Encyclop\u00E6dia-level know-how",
    "Jos\u00E9, Se\u00F1or, Cr\u00E8me and a na\u00EFve caf\u00E9 owner",
    "\u00DE\u00F3rr runs the crew",
    // A9c: precomposed letters are read as typed, the glottal stop is allowed, and CamelCase names are no claims
    "Ti\u1EC7m Gi\u1EB7t S\u1EA5y washes your quilts",
    "Ask for Sa\u00EFd at G\u00E9n\u00E9ration Nouvelle Bakery",
    "Icelandic b\u00F6nd, a d\u00E9cade, one doll\u00E1r",
    "Serving homes near dukM\u00E9\u0294em w\u00E1\u0165a",
    "Ask for McDonald or DeShawn",
    "StreakFree windows and HassleFree booking near McMillion Creek", // A9d: CamelCase names are read as typed, as at main
    "Our l\u00EDcensed team", // A9c accepted residual: a precomposed accented letter is read as typed
    // A9e: letters of the phonetic blocks in real names and places
    "Serving homes near Wew\u0259tanagok.", // GNIS 580743
    "Ask for Ay\u015F\u0259n \u018Fbd\u00FCl\u0259zimova", // Azerbaijani
    "Chevak Cup\uA78Cik dialect", // saltillo
    "Oberi \u0186kaim\u025B", // open o and open e
  ])("%j", (text) => {
    const faq = [{ question: "Why us?", answer: text }];
    const result = SiteDocument.safeParse({ ...MINIMAL_DOC, copy: { ...MINIMAL_DOC.copy, faq } });
    expect(result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([]);
  });
});
