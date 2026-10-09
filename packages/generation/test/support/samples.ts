import { Brief, type GenerationInputSnapshot } from "@asksite/core";
import { Facts, type Trade } from "@asksite/site-schema";

/** The facts fields of `trade`: trade "other" also names the owner's own business type. */
export const tradeFields = (trade: Trade): Pick<Facts, "trade" | "tradeOther"> => (trade === "other" ? { trade, tradeOther: "Bakery" } : { trade });

/** A plumber with every optional fact set, including every private one the model must never see. */
export const FULL_FACTS = Facts.parse({
  businessName: "Reliable Rooter",
  trade: "plumbing",
  phone: "+15125550142",
  email: "office@reliable.example.com",
  location: { streetAddress: "100 Congress Ave", city: "Austin", state: "TX", postalCode: "78701" },
  serviceArea: { places: ["Austin", "Round Rock", "78704"], note: "Within 25 miles of downtown Austin" },
  hours: [{ days: ["Monday", "Tuesday"], opens: "08:00", closes: "17:00" }],
  services: [{ name: "Drain cleaning", startingPrice: 89 }, { name: "Leak repair" }],
  licences: [{ label: "Texas master plumber", number: "M-40123" }],
  insured: true,
  yearFounded: 1998,
  emergency247: true,
  freeEstimates: true,
  testimonials: [{ quote: "Fixed our burst pipe the same night.", name: "Dana P.", location: "Round Rock, TX" }],
  heroPhoto: { url: "https://media.example.com/a/van.webp", alt: "Our service van", width: 1600, height: 900 },
  photos: [{ url: "https://media.example.com/a/p1.webp", alt: "New water heater", width: 1200, height: 900 }],
  socialLinks: [{ network: "facebook", url: "https://www.facebook.com/reliablerooter" }],
});

/** Only the required facts: no licence, insurance, emergency or free-estimate flags. */
export const MINIMAL_FACTS = Facts.parse({
  businessName: "Mop",
  trade: "cleaning",
  phone: "+15125550199",
  email: "hi@example.com",
  location: { city: "Austin", state: "TX" },
  serviceArea: { places: ["Austin"] },
  services: [{ name: "House cleaning" }],
});

export const BRIEF = Brief.parse({
  tone: "friendly",
  goal: "quote",
  differentiator: "We show up when we say we will",
  notes: "Mostly older homes. Please don't make us sound corporate.",
  comments: { services: "Water heaters are our favourite job" },
  reviewsAreReal: true,
});

export const FULL_SNAPSHOT: GenerationInputSnapshot = { facts: FULL_FACTS, brief: BRIEF };
export const MINIMAL_SNAPSHOT: GenerationInputSnapshot = { facts: MINIMAL_FACTS, brief: Brief.parse({ tone: "no-nonsense", goal: "call" }) };
