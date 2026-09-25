import { Brief, type GenerationInputSnapshot, type Issue } from "@asksite/core";
import { Facts } from "@asksite/site-schema";
import { MODEL_TEXT_CAPS } from "../src/model-facts.ts";
import { MAX_REPAIR_ISSUES } from "../src/prompt.ts";

// The largest prompt the builder can produce: every capped input at its cap, each field group in its
// costliest character, with the builder choices that make the prompt longest (goal "call", no founding
// year, every claim and section on). test/models.test.ts proves it: it tries every fill in every field
// group and in the repair lines, builds every trade, tone, goal and on/off choice, pins each cap to the
// edge of its real schema, and checks every fill against MAX_INPUT_TOKENS.
// Facts and Brief count their caps in code points. The prompt cuts the model's view of each owner string
// to its cap in UTF-16 units (MODEL_TEXT_CAPS), and repair lines too, so there a unit costs at most 3
// UTF-8 bytes and "€" (3 bytes, one unit) is the costliest: U+2028 and U+2029 become the 2-byte JSON
// escape \n in the data line (prompt.ts) and one space per run in a repair line; a lone surrogate becomes
// U+FFFD, 3 bytes (wellFormed); " and \ are 2-byte JSON escapes in the data line and in a repair line;
// U+1F600 is 2 units and 4 bytes. Facts rejects every control character and Brief every one except the
// newline, whose JSON escape \n costs 2 bytes, so no 6-byte \uXXXX escape reaches the prompt. Service
// names are never cut (the model copies them exactly), so there a character outside the BMP is the
// costliest: 4 bytes per counted character. Comment keys are 40 characters, the most Brief allows.
export const CAPS_FILLS: readonly string[] = ["€", "\u2028", "\u2029", "\uD800", "\"", "\\", "\u{1F600}"];

/** `fill` repeated to `cap` code points (U+1F600: 2 UTF-16 units each); a fill that .trim() removes (U+2028, U+2029) sits between two "a"s. */
const capped = (fill: string, cap: number): string => (fill.trim() === "" ? `a${fill.repeat(cap - 2)}a` : fill.repeat(cap));

/**
 * Every capped Facts and Brief input at its cap, made of `fill` (the service names of `serviceFill`), with
 * the longest builder choices: goal "call" and no yearFounded ("hasYearFounded":false is 1 byte longer;
 * the other claims keep the trust section on).
 */
export function capsSnapshot(fill: string, serviceFill: string = fill): GenerationInputSnapshot {
  const text = (cap: number) => capped(fill, cap);
  const cap = MODEL_TEXT_CAPS;
  return {
    facts: Facts.parse({
      businessName: text(cap.businessName),
      trade: "landscaping",
      phone: "+15125550100",
      email: "caps@example.com",
      location: { city: text(cap.city), state: "TX" },
      serviceArea: { places: Array.from({ length: 30 }, () => text(cap.place)) },
      services: Array.from({ length: 12 }, () => ({ name: capped(serviceFill, 40) })),
      licences: [{ label: "L", number: "1" }],
      insured: true,
      emergency247: true,
      freeEstimates: true,
      testimonials: [{ quote: "q", name: "n" }],
      photos: [{ url: "https://media.example.com/a/p.webp", alt: "a", width: 1, height: 1 }],
    }),
    brief: Brief.parse({
      tone: "professional",
      goal: "call",
      differentiator: text(cap.differentiator),
      notes: text(cap.notes),
      comments: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`q${String(i).padStart(2, "0")}${"x".repeat(37)}`, text(cap.comment)])),
    }),
  };
}

/** MAX_REPAIR_ISSUES issues, each path and message as long as a repair line keeps (60 and 200). */
export function capsRepair(fill: string): Issue[] {
  return Array.from({ length: MAX_REPAIR_ISSUES }, () => ({ path: [capped(fill, 60)], code: "custom", message: capped(fill, 200) }));
}

/** The costliest fill of each field group; the eval's --caps-probe sends it (Tasks 13 and 15). */
export const CAPS_SNAPSHOT: GenerationInputSnapshot = capsSnapshot("€", "\u{1F600}");
export const CAPS_REPAIR: Issue[] = capsRepair("€");
