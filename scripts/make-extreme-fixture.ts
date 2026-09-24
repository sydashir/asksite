// Writes fixtures/roofing-extreme.json: every owner and AI text field at its schema maximum,
// every list at its maximum count, plus long unbroken words (the headline, and upper-case ones as
// the first place, service, reviewer and licence number: capitals are the widest letters).
// Deterministic: same bytes every run.
// Run: node scripts/make-extreme-fixture.ts
import { writeFileSync } from "node:fs";

// No claim words (see packages/site-schema/src/claims.ts): "insurance" is backed by insured and
// "free" by freeEstimates, both true below.
const WORDS = (
  "storm hail wind shingle metal tile slate flashing gutter downspout underlayment ridge vent decking " +
  "inspection estimate insurance claim replacement repair leak attic ventilation siding skylight chimney " +
  "valley drip edge fascia soffit crew careful honest neighborly thorough reliable"
).split(" ");

/** Exactly `length` characters of words (no digits), starting with `start`, never ending in a space. */
function fill(length: number, start = "", seed = 0): string {
  const words = [...WORDS.slice(seed % WORDS.length), ...WORDS.slice(0, seed % WORDS.length)];
  let out = start;
  for (let i = 0; out.length < length; i++) {
    const word = words[i % words.length] ?? "x";
    out = out ? `${out} ${word}` : word.charAt(0).toUpperCase() + word.slice(1);
  }
  out = out.slice(0, length);
  return out.endsWith(" ") ? `${out.slice(0, -1)}x` : out;
}

function exact(value: string, length: number): string {
  if (value.length !== length) throw new Error(`${JSON.stringify(value)} is ${value.length} chars, expected ${length}`);
  return value;
}

const letter = (i: number) => String.fromCharCode(65 + i);
const times = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const NETWORKS = ["facebook", "instagram", "google", "yelp", "nextdoor", "youtube", "linkedin"];

const services = times(12, (i) => ({
  name: i === 0 ? exact("HAILSTORMDAMAGEINSPECTIONANDREROOFINGJOB", 40) : fill(40, `Service ${letter(i)}`, i),
  startingPrice: 100000,
}));

const doc = {
  facts: {
    businessName: exact("Longhorn Storm Restoration Roofing, Gutters, Siding & Window", 60),
    trade: "roofing",
    phone: "+12145550163",
    email: "estimates.and.insurance.claims.department@longhornstormrestoration.example.com",
    location: {
      streetAddress: fill(80, "Suite Four Hundred, Longhorn Storm Restoration Plaza,", 3),
      city: fill(40, "North Richland Hills", 5),
      state: "TX",
      postalCode: "76180",
    },
    serviceArea: {
      places: times(30, (i) => (i === 0 ? exact("NORTHRICHLANDHILLSWATAUGAHALTOMCITYAREAS", 40) : fill(40, `Place ${letter(i)}`, i))),
      note: fill(80, "Within two hours of Dallas", 7),
    },
    hours: DAYS.map((day) => ({ days: [day], opens: "06:00", closes: "21:30" })),
    services,
    licences: times(5, (i) => ({
      label: fill(40, `Licence ${letter(i)}`, i),
      number: i === 0 ? exact("RCATREGISTRATIONNUMBER00000001", 30) : `RCAT-${"X".repeat(25)}`,
    })),
    insured: true,
    yearFounded: 1850,
    emergency247: true,
    freeEstimates: true,
    testimonials: times(12, (i) => ({
      quote: fill(320, "", i),
      name: i === 0 ? exact("MAXIMILIANALEXANDERVONHOHENZOLLERNSMITHS", 40) : fill(40, `Reviewer ${letter(i)}`, i),
      location: fill(40, "Fort Worth", i),
    })),
    heroPhoto: { url: "https://picsum.photos/seed/longhorn-hero/2400/1350", alt: fill(125, "Crew installing", 1), width: 2400, height: 1350 },
    photos: times(12, (i) => ({
      url: `https://picsum.photos/seed/longhorn-${i + 1}/1200/900`,
      alt: fill(125, "Photo of", i),
      width: 1200,
      height: 900,
      caption: fill(80, "Caption", i),
    })),
    socialLinks: NETWORKS.map((network) => ({
      network,
      url: `https://www.${network}.com/longhorn-storm-restoration-roofing-gutters-siding-and-windows`,
    })),
  },
  copy: {
    heroHeadline: exact("Unbelievablyweathertightroofreplacements for every hailstorm across North Texas!", 80),
    heroSubheadline: fill(160, "", 2),
    ctaText: exact("Schedule a free estimate", 24),
    about: fill(480, "", 4),
    sectionIntros: Object.fromEntries(["services", "gallery", "faq", "contact"].map((key, i) => [key, fill(140, "", i)])),
    serviceDescriptions: services.map((service, i) => ({ service: service.name, description: fill(160, "", i) })),
    faq: times(8, (i) => ({ question: `${fill(79, "", i)}?`, answer: fill(320, "", i + 3) })),
  },
  layout: [
    { id: "hero", variant: "photo" },
    { id: "trust", variant: "band" },
    { id: "services", variant: "cards" },
    { id: "testimonials", variant: "masonry" },
    { id: "gallery", variant: "grid" },
    { id: "about", variant: "plain" },
    { id: "serviceArea", variant: "split" },
    { id: "faq", variant: "accordion" },
    { id: "contact", variant: "card" },
  ],
  theme: { palette: "charcoal-red", font: "friendly" },
};

writeFileSync(new URL("../fixtures/roofing-extreme.json", import.meta.url), `${JSON.stringify(doc, null, 2)}\n`);
console.log("wrote fixtures/roofing-extreme.json");
