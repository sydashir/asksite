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
    ["Get a free quote", "free"],
    ["There is no charge for a visit", "no charge"],
    ["A complimentary walkthrough", "complimentary"],
  ])("allows %j only when the owner's facts back it", (text, word) => {
    expect(unbackedClaims(text, NONE)).toEqual([word]);
    expect(unbackedClaims(text, ALL)).toEqual([]);
  });

  it("leaves ordinary sales copy alone", () => {
    expect(unbackedClaims("Careful cleaners for busy households. Hassle-free booking, one-off or weekly.", NONE)).toEqual([]);
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
    "Licen͏sed and insu͏red", // U+034F combining grapheme joiner splits "Licensed"/"insured"
    "Bon️ded crew", // U+FE0F variation selector splits "Bonded"
    "Satisfaction guaran︀teed", // U+FE00 variation selector splits "guaranteed"
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
    "Free estimates, no hidden fees",
    "Five-star rated, award-winning, BBB accredited",
    "“Best cleaners ever!” said Sarah",
    '"Best cleaners in Boise!" - Sarah K.',
    "‘Best cleaners ever!’ - Sarah",
    "Satisfaction guaranteed",
    "Licen͏sed and insu͏red",
    "Bon️ded crew",
    "Satisfaction guaran︀teed",
    "Friendly \u034F team",
  ])("%j", (claim) => {
    const faq = [{ question: "Why us?", answer: claim }];
    const result = SiteDocument.safeParse({ ...MINIMAL_DOC, copy: { ...MINIMAL_DOC.copy, faq } });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toEqual(["copy.faq.0.answer"]);
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
