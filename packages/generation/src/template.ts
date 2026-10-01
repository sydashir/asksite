import { AiAnswer, draftFromAnswer, type AiDraft, type Brief } from "@asksite/core";
import type { Facts, Theme, Trade } from "@asksite/site-schema";

// The labelled fallback draft (design §6.3): deterministic, trade-aware wording that is valid for
// ANY facts. It never quotes owner text (names can hold digits or claims), never states a claim
// word (licensed, insured, emergency...), and uses "free" only when the owner offers free
// estimates. The owner edits it, and a human approves every page.

interface TradeWords {
  headline: string;
  subheadline: string;
  about: string;
  // Fit any service of the trade; they repeat in order when an owner lists more than three services (known limit).
  descriptions: readonly [string, string, string];
  // The trade's palette and font. The page design is not the template's to choose: draftFromAnswer adds the trade's.
  theme: Pick<Theme, "palette" | "font">;
}

const WORDS: Record<Trade, TradeWords> = {
  plumbing: {
    headline: "Plumbing repairs and installs for your home",
    subheadline: "From leaky faucets to clogged drains, tell us what's going on and we'll help you figure out the next step.",
    about: "We're a local plumbing business serving homes in the area. Get in touch about the job, big or small, and we'll walk you through your options.",
    descriptions: [
      "Describe the problem or the project, and we'll explain what the work involves.",
      "Not sure this is the service you need? Just ask, and we'll go over it with you.",
      "Plumbing questions are welcome, whether you're ready to start or still deciding.",
    ],
    theme: { palette: "navy-orange", font: "clean" },
  },
  hvac: {
    headline: "Heating and cooling help for your home",
    subheadline: "Whether your system has stopped working or needs a tune-up, tell us what's happening and we'll help.",
    about: "We're a local heating and cooling business serving homes in the area. Get in touch about your system, and we'll walk you through your options.",
    descriptions: [
      "Tell us about your home's heating or cooling and what you'd like done.",
      "Wondering if this is what you need? Ask us and we'll talk it over.",
      "Before you decide, we can explain how this works and what to expect.",
    ],
    theme: { palette: "blue-yellow", font: "clean" },
  },
  electrical: {
    headline: "Electrical work for your home",
    subheadline: "From faulty outlets to new lighting, tell us what you need and we'll help you plan it.",
    about: "We're a local electrical business serving homes in the area. Get in touch about your project or repair, and we'll walk you through your options.",
    descriptions: [
      "Describe what you'd like done and where, and we'll go over it with you.",
      "Questions before you get started? Give us a call or drop us a line.",
      "Find out what's involved and what to expect before you decide.",
    ],
    theme: { palette: "charcoal-red", font: "sturdy" },
  },
  roofing: {
    headline: "Roof repairs and replacements",
    subheadline: "Leaks, damaged shingles or a whole new roof: tell us what you're seeing and we'll help you plan what comes next.",
    about: "We're a local roofing business serving homes in the area. Get in touch about your roof, and we'll walk you through your options.",
    descriptions: [
      "Share a little about your home and the work you have in mind, and we'll explain the process.",
      "Wondering what the job calls for? Ask us and we'll talk it over with you.",
      "Roofing questions are welcome, from small concerns to bigger plans.",
    ],
    theme: { palette: "charcoal-red", font: "sturdy" },
  },
  cleaning: {
    headline: "Cleaning services for your home",
    subheadline: "Let us know what needs cleaning and how often, and we'll work out a plan with you.",
    about: "We're a local cleaning business serving homes in the area. Get in touch about what you need, and we'll walk you through your options.",
    descriptions: [
      "Describe the space and anything that needs extra attention, so we know what to expect.",
      "Questions about what's included? Ask us and we'll explain before you book.",
      "Have special requests or products you prefer? Mention them when you contact us.",
    ],
    theme: { palette: "blue-yellow", font: "friendly" },
  },
  landscaping: {
    headline: "Lawn, garden and yard care",
    subheadline: "From regular mowing to new planting beds, tell us about your yard and we'll help you plan the work.",
    about: "We're a local landscaping business serving homes in the area. Whether it's ongoing care or something new, get in touch and we'll walk you through your options.",
    descriptions: [
      "Let us know how you use your outdoor space and what matters most to you.",
      "Questions about this service? Ask us and we'll talk it over.",
      "Give us a call or send a message with any questions you have.",
    ],
    theme: { palette: "green-amber", font: "friendly" },
  },
};

function ctaText(goal: Brief["goal"], freeEstimates: boolean): string {
  if (goal === "book") return "Book a visit";
  if (goal === "call") return "Request a callback";
  return freeEstimates ? "Get a free quote" : "Request a quote";
}

/** The template's answer, shaped as the model's (no design), valid for any valid facts, in parsed form. Every section is listed; empty ones hide. */
export function templateAnswer(facts: Facts, brief: Brief): AiAnswer {
  const words = WORDS[facts.trade];
  return AiAnswer.parse({
    copy: {
      heroHeadline: words.headline,
      heroSubheadline: words.subheadline,
      ctaText: ctaText(brief.goal, facts.freeEstimates),
      about: words.about,
      sectionIntros: {
        services: "Here's what we can help with.",
        gallery: "A few examples of our work.",
        contact: "Send us a few details and we'll get back to you.",
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

/** The labelled fallback draft to store: the template's answer on the trade's design, like a model's answer. */
export function templateDraft(facts: Facts, brief: Brief): AiDraft {
  return draftFromAnswer(templateAnswer(facts, brief), facts.trade);
}
