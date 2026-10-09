import type { StepId } from "./route.ts";

export const STEP_TITLE: Record<StepId, string> = {
  business: "Your business",
  services: "Your services",
  area: "Where you work and when",
  trust: "Why customers can trust you",
  photos: "Photos and links",
  words: "In your own words",
  address: "Your web address",
};

export const TRADE_OPTIONS = [
  { value: "it", label: "IT firm" },
  { value: "law", label: "Law firm" },
  { value: "plumbing", label: "Plumbing" },
  { value: "hvac", label: "Heating and cooling (HVAC)" },
  { value: "electrical", label: "Electrical" },
  { value: "roofing", label: "Roofing" },
  { value: "cleaning", label: "Cleaning" },
  { value: "landscaping", label: "Landscaping and lawn care" },
  { value: "other", label: "Other" },
] as const;

/** facts.serviceAreaScope; "places" is stored as no scope at all, so a draft that never chose stays as it was. */
export const SCOPE_OPTIONS = [
  { value: "places", label: "In specific places" },
  { value: "country", label: "Across the whole country" },
  { value: "worldwide", label: "Worldwide" },
] as const;

export const TONE_OPTIONS = [
  { value: "friendly", label: "Friendly", hint: "Warm and neighborly" },
  { value: "professional", label: "Professional", hint: "Calm and businesslike" },
  { value: "no-nonsense", label: "Straight to the point", hint: "Short and direct" },
] as const;

export const GOAL_OPTIONS = [
  { value: "call", label: "Call us" },
  { value: "quote", label: "Ask for a quote" },
  { value: "book", label: "Book a visit" },
] as const;

export const NETWORK_OPTIONS = [
  { value: "facebook", label: "Facebook" },
  { value: "instagram", label: "Instagram" },
  { value: "google", label: "Google Business Profile" },
  { value: "yelp", label: "Yelp" },
  { value: "nextdoor", label: "Nextdoor" },
  { value: "youtube", label: "YouTube" },
  { value: "linkedin", label: "LinkedIn" },
] as const;

export const US_STATES = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"], ["CO", "Colorado"],
  ["CT", "Connecticut"], ["DE", "Delaware"], ["DC", "District of Columbia"], ["FL", "Florida"], ["GA", "Georgia"],
  ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"],
  ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"], ["MA", "Massachusetts"],
  ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"],
  ["NE", "Nebraska"], ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"],
  ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"],
  ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"], ["SC", "South Carolina"], ["SD", "South Dakota"],
  ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"],
  ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
].map(([value, label]) => ({ value: value!, label: label! }));
