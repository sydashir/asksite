import { SiteDocument, type PageId, type SiteDocumentInput } from "@asksite/site-schema";
import type { RenderContext } from "../../src/context.ts";
import { safeUrl } from "../../src/html.ts";
import { sitePages } from "../../src/visibility.ts";

/** A complete, valid plumber document with every optional fact filled in. */
export const FULL: SiteDocumentInput = {
  facts: {
    businessName: "Reliable Rooter",
    trade: "plumbing",
    phone: "+15125550142",
    email: "office@example.com",
    location: { streetAddress: "100 Congress Ave", city: "Austin", state: "TX", postalCode: "78701" },
    serviceArea: { places: ["Austin", "Round Rock", "78704"], note: "Within 25 miles of downtown Austin" },
    hours: [
      { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "08:00", closes: "17:00" },
      { days: ["Saturday"], opens: "09:00", closes: "13:00" },
    ],
    services: [
      { name: "Drain cleaning", startingPrice: 89 },
      { name: "Water heaters", startingPrice: 1250 },
      { name: "Leak repair" },
    ],
    licences: [{ label: "Texas master plumber", number: "M-40123" }],
    insured: true,
    yearFounded: 1998,
    emergency247: true,
    freeEstimates: true,
    testimonials: [
      { quote: "Fixed our burst pipe the same night.", name: "Dana P.", location: "Round Rock, TX" },
      { quote: "Honest price and a tidy crew.", name: "Luis M." },
    ],
    heroPhoto: { url: "https://images.example.com/van.jpg", alt: "Our service van", width: 1600, height: 900 },
    photos: [
      { url: "https://images.example.com/p1.jpg", alt: "New water heater in a garage", width: 1200, height: 900, caption: "Water heater swap" },
      { url: "https://images.example.com/p2.jpg", alt: "Cleared kitchen drain", width: 1200, height: 900 },
    ],
    socialLinks: [{ network: "facebook", url: "https://www.facebook.com/reliablerooter" }],
  },
  copy: {
    heroHeadline: "Fast, friendly plumbing across Austin",
    heroSubheadline: "Leaks, clogs and water heaters fixed right the first time.",
    ctaText: "Get a free quote",
    about: "We are a family business that treats every home like our own.",
    sectionIntros: { services: "Everything from dripping taps to new water heaters.", faq: "Straight answers before you call." },
    serviceDescriptions: [
      { service: "Drain cleaning", description: "We clear stubborn drains without tearing up your yard." },
      { service: "Water heaters", description: "Tank and tankless units installed the same week." },
      { service: "Leak repair", description: "We find hidden leaks before they ruin your floors." },
    ],
    faq: [
      { question: "Do you charge for estimates?", answer: "No. Estimates are always free." },
      { question: "Can you come out for an emergency?", answer: "Yes, we answer emergencies around the clock." },
    ],
  },
  layout: [
    { id: "hero", variant: "photo" },
    { id: "trust", variant: "band" },
    { id: "testimonials", variant: "grid" },
    { id: "services", variant: "cards" },
    { id: "faq", variant: "accordion" },
    { id: "about", variant: "plain" },
    { id: "gallery", variant: "grid" },
    { id: "contact", variant: "card" },
    { id: "serviceArea", variant: "split" },
  ],
  theme: { palette: "navy-orange", font: "clean" },
};

/** FULL with every optional fact and copy field removed. */
export const MINIMAL: SiteDocumentInput = {
  facts: {
    businessName: "Mop",
    trade: "cleaning",
    phone: "+15125550199",
    email: "hi@example.com",
    location: { city: "Austin", state: "TX" },
    serviceArea: { places: ["Austin"] },
    services: [{ name: "House cleaning" }],
  },
  copy: {
    heroHeadline: "A spotless home",
    heroSubheadline: "Careful cleaners for busy households.",
    ctaText: "Book a clean",
    serviceDescriptions: [{ service: "House cleaning", description: "Weekly or one-off cleans." }],
  },
  layout: FULL.layout,
  theme: { palette: "green-amber", font: "friendly" },
};

/** The context of one page of the site (Home unless told otherwise); throws when the site has no such page. */
export function makeContext(input: SiteDocumentInput, pageId: PageId = "home"): RenderContext {
  const doc = SiteDocument.parse(input);
  const pages = sitePages(doc);
  const page = pages.find((p) => p.id === pageId);
  if (page === undefined) throw new Error(`The site has no ${pageId} page`);
  return { doc, page, pages, formAction: safeUrl("https://forms.example.com/submit") };
}
