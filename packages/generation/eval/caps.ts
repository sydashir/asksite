import { Brief, type GenerationInputSnapshot, type Issue } from "@asksite/core";
import { Facts } from "@asksite/site-schema";
import { MAX_REPAIR_ISSUES } from "../src/prompt.ts";

// The largest prompt the builder can produce: every capped input at its cap, all of it one fill
// character (of the uncapped choices, goal "call" and no founding year would add 4 bytes).
// CAPS_FILLS holds the costliest character of each class Facts and Brief accept, and the prompt
// encodes each as: "€" 3 UTF-8 bytes; U+2028 and U+2029 the 2-byte JSON escape \n in the data
// line (prompt.ts) and one space per run in a repair line; a lone surrogate U+FFFD, 3 bytes (every
// owner string and every repair line goes through wellFormed); " and \ their 2-byte JSON escapes
// (1 byte in a repair line). Facts and Brief reject control characters, so no 6-byte \uXXXX
// escape reaches the prompt. test/models.test.ts checks every fill against MAX_INPUT_TOKENS and
// that no fill beats "€", so CAPS_SNAPSHOT and CAPS_REPAIR use the costliest fill. Comment keys
// are 40 characters, the most Brief allows.
export const CAPS_FILLS: readonly string[] = ["€", "\u2028", "\u2029", "\uD800", "\"", "\\"];

/** `fill` repeated to `cap` UTF-16 units; a fill that .trim() removes (U+2028, U+2029) sits between two "a"s. */
const capped = (fill: string, cap: number): string => (fill.trim() === "" ? `a${fill.repeat(cap - 2)}a` : fill.repeat(cap));

/** Every capped Facts and Brief input at its cap, made of `fill`. */
export function capsSnapshot(fill: string): GenerationInputSnapshot {
  const text = (cap: number) => capped(fill, cap);
  return {
    facts: Facts.parse({
      businessName: text(60),
      trade: "landscaping",
      phone: "+15125550100",
      email: "caps@example.com",
      location: { city: text(40), state: "TX" },
      serviceArea: { places: Array.from({ length: 30 }, () => text(40)) },
      services: Array.from({ length: 12 }, () => ({ name: text(40) })),
      licences: [{ label: "L", number: "1" }],
      insured: true,
      yearFounded: 1998,
      emergency247: true,
      freeEstimates: true,
      testimonials: [{ quote: "q", name: "n" }],
      photos: [{ url: "https://media.example.com/a/p.webp", alt: "a", width: 1, height: 1 }],
    }),
    brief: Brief.parse({
      tone: "professional",
      goal: "quote",
      differentiator: text(140),
      notes: text(2000),
      comments: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`q${String(i).padStart(2, "0")}${"x".repeat(37)}`, text(500)])),
    }),
  };
}

/** MAX_REPAIR_ISSUES issues, each path and message as long as a repair line keeps (60 and 200). */
export function capsRepair(fill: string): Issue[] {
  return Array.from({ length: MAX_REPAIR_ISSUES }, () => ({ path: [capped(fill, 60)], code: "custom", message: capped(fill, 200) }));
}

/** The costliest fill; the eval's --caps-probe sends it (Tasks 13 and 15). */
export const CAPS_SNAPSHOT: GenerationInputSnapshot = capsSnapshot("€");
export const CAPS_REPAIR: Issue[] = capsRepair("€");
