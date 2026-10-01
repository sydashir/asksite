// Words the Modern design derives from the owner's facts and the AI's copy. Nothing here adds a fact: each
// helper only shortens, groups or repeats text the page already shows.
import type { Facts, OpeningHours } from "@asksite/site-schema";
import { TRADE_LABEL, weeklyHours } from "../../format.ts";

const FILLER = ["get a ", "get an ", "get your ", "get ", "request a ", "request an ", "request your ", "request ", "ask for a ", "ask for an ", "ask for "];
const CALL_VERBS = ["call", "phone", "dial", "text"];
const CTA_VERBS = ["book", "schedule", "request", "reserve", "contact", "start", "claim", "check", "ask", "get", "order", "plan"];
/** The longest labels that fit beside the phone number in the call bar: from 340 px, and below it (both engines, all three letterings). */
const SHORT_MAX = 13;
const TINY_MAX = 9;

const upperFirst = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
const lastWord = (text: string) => upperFirst(text.split(" ").at(-1) ?? text);

/**
 * The phone call bar's labels for the owner's call to action: `short` (at most 13 characters) from 340 px,
 * `tiny` (one word) below. "Get a free quote" gives "Free quote" and "Quote"; "Book a visit" gives "Book a
 * visit" and "Book"; "Free estimate" gives "Free estimate" and "Estimate". The button opens the form, so a CTA
 * that starts with a call verb, or a label that would still not fit, becomes "Contact us" ("Contact" below 340 px).
 * Every other label is the CTA's own words, cut down.
 */
export function ctaLabels(cta: string): { short: string; tiny: string } {
  const { short, tiny } = cutLabels(cta);
  // A label still too long for its width (one long word) becomes plain navigation text.
  return { short: short.length <= SHORT_MAX ? short : "Contact us", tiny: tiny.length <= TINY_MAX ? tiny : "Contact" };
}

function cutLabels(cta: string): { short: string; tiny: string } {
  const text = cta.split(/\s+/).filter(Boolean).join(" ");
  const lower = text.toLowerCase();
  const filler = FILLER.find((start) => lower.startsWith(start) && text.length > start.length);
  if (filler !== undefined) {
    const rest = upperFirst(text.slice(filler.length));
    return { short: rest.length <= SHORT_MAX ? rest : lastWord(rest), tiny: lastWord(rest) };
  }
  const words = text.split(" ");
  const first = words[0] ?? text;
  if (CALL_VERBS.includes(first.toLowerCase())) return { short: "Contact us", tiny: "Contact" };
  // One word: the verb when the CTA starts with one ("Schedule service" -> "Schedule"), else the noun at the
  // end ("Free estimate" -> "Estimate", never a bare "Free").
  const one = CTA_VERBS.includes(first.toLowerCase()) || words.length === 1 ? first : lastWord(text);
  return { short: text.length <= SHORT_MAX ? text : one, tiny: one };
}

/** The weekly hours with consecutive days of the same time in one row: "Monday – Friday". */
export function groupedHours(hours: readonly OpeningHours[]): Array<{ days: string; time: string }> {
  const rows: Array<{ first: string; last: string; time: string }> = [];
  for (const { day, time } of weeklyHours(hours)) {
    const previous = rows.at(-1);
    if (previous !== undefined && previous.time === time) previous.last = day;
    else rows.push({ first: day, last: day, time });
  }
  return rows.map(({ first, last, time }) => ({ days: first === last ? first : `${first} – ${last}`, time }));
}

/** "Plumbing · Austin, TX", or undefined when the headline already names the city. */
export function tradeAndCity(facts: Facts, headline: string): string | undefined {
  const { city, state } = facts.location;
  return headline.toLowerCase().includes(city.toLowerCase()) ? undefined : `${TRADE_LABEL[facts.trade]} · ${city}, ${state}`;
}

/** "Boise, ID" or "Boise, ID and Meridian": one or two places as words, the home town with its state. */
export function fewPlaces(facts: Facts): string {
  const { city, state } = facts.location;
  return facts.serviceArea.places
    .map((place) => (place.trim().toLowerCase() === city.trim().toLowerCase() ? `${place}, ${state}` : place))
    .join(" and ");
}

/**
 * The service area in a few words, for the no-photo hero's card: one or two places as the section says them
 * ("Boise, ID"), three by name ("Kyle, Austin and Buda"), more as the first two and a count ("Austin, Round Rock
 * and 5 more"; the section lists them all).
 */
export function areaSummary(facts: Facts): string {
  const { places } = facts.serviceArea;
  if (places.length <= 2) return fewPlaces(facts);
  if (places.length === 3) return `${places[0]}, ${places[1]} and ${places[2]}`;
  return `${places[0]}, ${places[1]} and ${places.length - 2} more`;
}

/** The home town line: "Austin, TX 78745". */
export function cityLine(facts: Facts): string {
  const { city, state, postalCode } = facts.location;
  return `${city}, ${state}${postalCode === undefined ? "" : ` ${postalCode}`}`;
}
