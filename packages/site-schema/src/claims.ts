import type { Copy } from "./copy.ts";
import type { Facts } from "./facts.ts";

// Claim checker for AI copy. Credentials, insurance, time in business, hours, prices, reviews
// and contact details are owner facts that the renderer shows from `facts`. Copy may mention a
// claim only when the owner's facts back it, and never mentions a claim no fact can back.
// Word lists catch the usual phrasings, not every paraphrase: plan 4's approval screen still
// shows the owner every sentence before a page is published.

/** Claims no owner fact backs: rejected in copy whatever the facts say. */
export const NEVER_IN_COPY: readonly RegExp[] = [
  /\bbond(s|ed)?\b/i, // California B&P Code 7071.13 forbids mentioning the contractor bond in advertising
  /\b(certified|accredited|award[- ]winning|top[- ]rated|five[- ]star|rated|ratings?|bbb)\b/i,
  /\b(reviews?|says?|said)\b|[“”„«»]/i, // real reviews are owner facts; no quotes invented in copy
  /\b(guarantee[ds]?|warrant(y|ies|ied))\b/i,
  /\b(cheapest|lowest|dollars?|bucks|cents)\b/i,
  /\b((twen|thir|for|fif|six|seven|eigh|nine)ty|hundreds?|thousands?|millions?)\b/i, // spelled-out numbers
  /\b(since|years?|decades?|established|founded|generations?)\b/i, // time in business comes from yearFounded
  /\b(same[- ]day|next[- ]day|weekends?|(mon|tues|wednes|thurs|fri|satur|sun)days?)\b/i, // hours are facts
  /\b[a-z0-9-]+\.(com|net|org|us|biz|info|co|io)\b/i, // bare web addresses
];

/** Claims allowed only when the owner's facts back them. */
export const NEEDS_A_FACT: ReadonlyArray<{ readonly pattern: RegExp; readonly backedBy: (facts: Facts) => boolean }> = [
  { pattern: /\blicen[cs]\w*/i, backedBy: (facts) => facts.licences.length > 0 },
  { pattern: /\binsur\w*/i, backedBy: (facts) => facts.insured },
  { pattern: /\b(emergenc\w*|a?round[- ]the[- ]clock|day or night|any ?time)\b/i, backedBy: (facts) => facts.emergency247 },
  { pattern: /(?<![\w-])free\b|\bno[- ](charge|cost)\b|\bcomplimentary\b/i, backedBy: (facts) => facts.freeEstimates },
];

/** The words in `text` that state a claim the owner's facts do not back (empty when the text is fine). */
export function unbackedClaims(text: string, facts: Facts): string[] {
  const found: string[] = [];
  for (const pattern of NEVER_IN_COPY) {
    const match = pattern.exec(text);
    if (match) found.push(match[0]);
  }
  for (const { pattern, backedBy } of NEEDS_A_FACT) {
    const match = pattern.exec(text);
    if (match && !backedBy(facts)) found.push(match[0]);
  }
  return found;
}

type Path = Array<string | number>;

/**
 * Every prose string in the copy with its path, found by walking the object, so a copy field
 * added later is checked automatically. `service` keys are skipped: they repeat owner facts.
 */
export function proseIn(copy: Copy): Array<[Path, string]> {
  const out: Array<[Path, string]> = [];
  const walk = (value: unknown, path: Path): void => {
    if (typeof value === "string") out.push([path, value]);
    else if (Array.isArray(value)) value.forEach((item, i) => walk(item, [...path, i]));
    else if (typeof value === "object" && value !== null)
      for (const [key, item] of Object.entries(value)) if (key !== "service") walk(item, [...path, key]);
  };
  walk(copy, []);
  return out;
}
