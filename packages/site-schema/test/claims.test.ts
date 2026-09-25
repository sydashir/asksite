import { describe, expect, it } from "vitest";
import { Facts, HIDDEN_IN_COPY, proseIn, SiteDocument, unbackedClaims, type SiteDocumentInput } from "../src/index.ts";

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

  // A9: claims are matched after NFD and the removal of every combining mark (\p{M}), so an accent or a
  // mark between two words cannot hide a claim word.
  it.each([
    ["Our lícensed team", "licensed"], // U+00ED i with acute
    ["Our li\u0301censed team", "licensed"], // i + U+0301 combining acute
    ["Fully i\u0308nsured", "insured"], // i + U+0308 combining diaeresis
    ["Licen\u0336sed crew", "Licensed"], // U+0336 combining long stroke overlay inside the word
    ["Licen\u20DDsed crew", "Licensed"], // U+20DD combining enclosing circle (an enclosing mark, Me)
    ["Licen\u{1D165}sed crew", "Licensed"], // U+1D165 musical symbol combining stem (a spacing mark, Mc)
    ["Get a frée quote", "free"],
  ])("reads %j with its marks removed and finds %j unless the facts back it", (text, word) => {
    expect(unbackedClaims(text, NONE)).toEqual([word]);
    expect(unbackedClaims(text, ALL)).toEqual([]);
  });

  it.each([
    ["Award \u0336winning crew", "Award winning"], // A8c-3: U+0336 splits the claim from the space
    ["Same \u0336day help", "Same day"],
    ["Award\u0336 winning crew", "Award winning"],
    ["Fïve-stär service", "Five-star"],
    ["Satisfaction guaránteed", "guaranteed"],
  ])("never allows %j (%j once its marks are removed), whatever the facts", (text, claim) => {
    expect(unbackedClaims(text, NONE)).toEqual([claim]);
    expect(unbackedClaims(text, ALL)).toEqual([claim]);
  });

  it.each([
    "Café-clean kitchens, naïve questions welcome",
    "Jalapeño stains lifted",
    "Crème brûlée spills, gone",
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
    ["ǀicensed crew", "licensed"], // U+01C0 dental click
    ["Fully ınsuređ", "insured"],
    ["Help around þe clock", "around the clock"], // þ reads "th"
    ["Help day or ŋight", "day or night"], // U+014B eng
    ["There is ŋo charge", "no charge"],
  ])("reads the look-alike letters in %j as A-Z and finds %j unless the facts back it", (text, word) => {
    expect(unbackedClaims(text, NONE)).toEqual([word]);
    expect(unbackedClaims(text, ALL)).toEqual([]);
  });

  it.each([
    ["ƁONDED CREW", "BONDED"], // U+0181 capital B with hook
    ["Bøndéd crew", "Bonded"],
    ["Certifieđ technicians", "Certified"],
    ["Satisfaction guaranteeđ", "guaranteed"],
    ["Top-ɍated crew", "Top-rated"], // U+024D r with stroke
    ["Ƒive-star service", "Five-star"],
  ])("never allows %j (%j once read as A-Z), whatever the facts", (text, claim) => {
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
  ])("finds no claim in real place names and people's names: %j", (text) => {
    expect(unbackedClaims(text, NONE)).toEqual([]);
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
    "Our l\u00EDcensed team",
    "L\u0131censed and \u0131nsured plumbers", // U+0131 dotless i (A9b: read as "i", so a claim)
    "\u029F\u026A\u1D04\u1D07\u0274\uA731\u1D07\u1D05 \u1D00\u0274\u1D05 \u026A\u0274\uA731\u1D1C\u0280\u1D07\u1D05 plumbers", // small capitals (refused by Copy)
    "Licen\u0282ed plumbers", // U+0282 s with hook (IPA Extensions, refused by Copy)
    "Get a \u0192ree quote", // A9b: U+0192 f with hook reads "free"
    "\u0141ICENSED PLUMBERS", // A9b: U+0141 reads "L"
    "FULLY \u0196NSURED", // A9b: U+0196 capital iota reads "I"
    "\u026Ansured plumbers", // U+026A small capital I (refused by Copy)
    "\u1D04ertified crew", // U+1D04 small capital C (refused by Copy)
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
  ])("%j", (text) => {
    const faq = [{ question: "Why us?", answer: text }];
    const result = SiteDocument.safeParse({ ...MINIMAL_DOC, copy: { ...MINIMAL_DOC.copy, faq } });
    expect(result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([]);
  });
});
