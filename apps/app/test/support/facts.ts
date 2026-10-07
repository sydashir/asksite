// Answers a finished questionnaire produces, for tests. Phone numbers use the fictional 555-01xx range.
export const VALID_FACTS = {
  businessName: "Joe's Plumbing",
  trade: "plumbing",
  phone: "+15125550142",
  email: "office@joesplumbing.example",
  location: { city: "Austin", state: "TX" },
  serviceArea: { places: ["Austin", "Round Rock"] },
  services: [{ name: "Drain cleaning", startingPrice: 89 }, { name: "Water heaters" }],
} as const;

export const VALID_BRIEF = { tone: "friendly", goal: "call" } as const;
