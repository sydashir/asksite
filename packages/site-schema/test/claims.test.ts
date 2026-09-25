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
    ["Open seven days a week", "seven days"],
    ["Out on call five days a week", "days a week"],
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
    ["Get a free quote", "free", "freeEstimates"],
  ] as const)("allows %j when only its own fact (%s) is set, and rejects it when every other fact is set instead", (text, word, fact) => {
    expect(unbackedClaims(text, ONLY[fact])).toEqual([]);
    expect(unbackedClaims(text, ALL_BUT[fact])).toEqual([word]);
  });

  it("leaves ordinary sales copy alone", () => {
    expect(unbackedClaims("Careful cleaners for busy households. Hassle-free booking, one-off or weekly.", NONE)).toEqual([]);
  });

  it.each(["Most jobs take a few days", "Book a week ahead", "Seven rooms, one crew"])("does not read %j as a round-the-clock claim", (text) => {
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
    ["Open seven\u00A0days", "seven days"],
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

  it.each(["-", ...DASHES].flatMap((d) => ["day" + d + "or" + d + "night", "any" + d + "time", "seven" + d + "days", "days" + d + "a" + d + "week"]))(
    "allows the emergency claim %j, joined by a hyphen or dash, only when the owner's facts back it",
    (claim) => {
      const text = "Call us " + claim + " for a burst pipe";
      expect(unbackedClaims(text, NONE)).toEqual([claim]);
      expect(unbackedClaims(text, ALL)).toEqual([]);
    },
  );

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
    "“Best cleaners ever!” said Sarah",
    '"Best cleaners in Boise!" - Sarah K.',
    "‘Best cleaners ever!’ - Sarah",
    "Satisfaction guaranteed",
    "Licen\u034Fsed and insu\u034Fred",
    "Bon\uFE0Fded crew",
    "Satisfaction guaran\uFE00teed",
    "Friendly \u034F team",
  ])("%j", (claim) => {
    const faq = [{ question: "Why us?", answer: claim }];
    const result = SiteDocument.safeParse({ ...MINIMAL_DOC, copy: { ...MINIMAL_DOC.copy, faq } });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toEqual(["copy.faq.0.answer"]);
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
    '" autofocus onfocus="alert(document.cookie)', // Task 15's XSS fixture puts these in AI copy
    '<iframe srcdoc="<script>alert(document.domain)</script>"></iframe>',
  ])("%j", (text) => {
    const faq = [{ question: "Why us?", answer: text }];
    const result = SiteDocument.safeParse({ ...MINIMAL_DOC, copy: { ...MINIMAL_DOC.copy, faq } });
    expect(result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([]);
  });
});
