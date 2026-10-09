// Words the Modern design derives from the owner's facts and the AI's copy. Nothing here adds a fact: each
// helper only shortens, groups or repeats text the page already shows.
import type { Facts, OpeningHours, Trade } from "@asksite/site-schema";
import { TRADE_LABEL, weeklyHours } from "../../format.ts";

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

// Who or what a visitor needs from each trade, as the closing band asks it.
const NEED: Record<Trade, string> = {
  plumbing: "a plumber",
  hvac: "heating or cooling help",
  electrical: "an electrician",
  roofing: "a roofer",
  cleaning: "a cleaner",
  landscaping: "a landscaper",
  it: "IT help",
  law: "legal help",
  other: "help",
};

/** "Need a plumber in Austin?": the owner's trade and home town, and nothing else, as a question. */
export const needQuestion = (facts: Facts): string => `Need ${NEED[facts.trade]} in ${facts.location.city}?`;

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
