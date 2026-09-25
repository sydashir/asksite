import { AiDraft, type Brief } from "@asksite/core";
import type { Facts, Theme, Trade } from "@asksite/site-schema";

// The labelled fallback draft (design §6.3): deterministic, trade-aware wording that is valid for
// ANY facts. It never quotes owner text (names can hold digits or claims), never states a claim
// word (licensed, insured, emergency...), and uses "free" only when the owner offers free
// estimates. The owner edits it, and a human approves every page.

interface TradeWords {
  headline: string;
  subheadline: string;
  about: string;
  descriptions: readonly [string, string, string];
  theme: Theme;
}

const DESCRIPTIONS: TradeWords["descriptions"] = [
  "Tell us what is going on and we will talk you through the options.",
  "Careful work, explained in plain words, with the mess cleaned up afterwards.",
  "Ask us about this service and we will explain what is involved.",
];

const WORDS: Record<Trade, TradeWords> = {
  plumbing: {
    headline: "Plumbing repairs and installs for your home",
    subheadline: "From leaky faucets to clogged drains, tell us what is going on and we will help you sort it out.",
    about: "We are a local plumbing business serving homes in the area. Tell us about the job and we will talk you through your options.",
    descriptions: DESCRIPTIONS,
    theme: { palette: "navy-orange", font: "clean" },
  },
  hvac: {
    headline: "Heating and cooling help for your home",
    subheadline: "Whether your system has stopped working or needs a check, tell us what is happening and we will help.",
    about: "We are a local heating and cooling business serving homes in the area. Tell us about your system and we will talk you through your options.",
    descriptions: DESCRIPTIONS,
    theme: { palette: "blue-yellow", font: "clean" },
  },
  electrical: {
    headline: "Electrical work for your home",
    subheadline: "From faulty outlets to new lighting, tell us what you need and we will help you plan it.",
    about: "We are a local electrical business serving homes in the area. Tell us about the job and we will talk you through your options.",
    descriptions: DESCRIPTIONS,
    theme: { palette: "charcoal-red", font: "sturdy" },
  },
  roofing: {
    headline: "Roof repairs and replacements",
    subheadline: "Leaks, damaged shingles or a whole new roof: tell us what you are seeing and we will get back to you.",
    about: "We are a local roofing business serving homes in the area. Tell us about your roof and we will talk you through your options.",
    descriptions: DESCRIPTIONS,
    theme: { palette: "charcoal-red", font: "sturdy" },
  },
  cleaning: {
    headline: "Cleaning services for your home",
    subheadline: "Tell us what you need cleaned and how often, and we will get back to you with the details.",
    about: "We are a local cleaning business serving homes in the area. Tell us what you need and we will talk you through your options.",
    descriptions: DESCRIPTIONS,
    theme: { palette: "blue-yellow", font: "friendly" },
  },
  landscaping: {
    headline: "Lawn, garden and yard care",
    subheadline: "From regular mowing to new planting beds, tell us about your yard and we will help you plan the work.",
    about: "We are a local landscaping business serving homes in the area. Tell us about your yard and we will talk you through your options.",
    descriptions: DESCRIPTIONS,
    theme: { palette: "green-amber", font: "friendly" },
  },
};

function ctaText(goal: Brief["goal"], freeEstimates: boolean): string {
  if (goal === "book") return "Book a visit";
  if (goal === "call") return "Request a callback";
  return freeEstimates ? "Get a free quote" : "Request a quote";
}

/** A valid AI draft for any valid facts, in parsed form. Every section is listed; empty ones hide. */
export function templateDraft(facts: Facts, brief: Brief): AiDraft {
  const words = WORDS[facts.trade];
  return AiDraft.parse({
    copy: {
      heroHeadline: words.headline,
      heroSubheadline: words.subheadline,
      ctaText: ctaText(brief.goal, facts.freeEstimates),
      about: words.about,
      sectionIntros: {
        services: "Here is what we can help with.",
        gallery: "A few examples of our work.",
        contact: "Send us a few details and we will get back to you.",
      },
      serviceDescriptions: facts.services.map((service, i) => ({
        service: service.name,
        description: words.descriptions[i % words.descriptions.length],
      })),
      faq: [],
    },
    layout: [
      { id: "hero", variant: facts.heroPhoto === undefined ? "centered" : "photo" },
      { id: "trust", variant: "band" },
      { id: "services", variant: "cards" },
      { id: "testimonials", variant: "grid" },
      { id: "gallery", variant: "grid" },
      { id: "about", variant: "plain" },
      { id: "serviceArea", variant: "split" },
      { id: "faq", variant: "accordion" },
      { id: "contact", variant: "card" },
    ],
    theme: words.theme,
  });
}
