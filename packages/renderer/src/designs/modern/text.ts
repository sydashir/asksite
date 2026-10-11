// Words the Modern design derives from the owner's facts and the AI's copy. Nothing here adds a fact: each
// helper only shortens, groups or repeats text the page already shows.
import type { Facts, OpeningHours, Trade } from "@asksite/site-schema";
import { scopeLine, shownArea, tradeLabel, weeklyHours } from "../../format.ts";

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
  return headline.toLowerCase().includes(city.toLowerCase()) ? undefined : `${tradeLabel(facts)} · ${city}, ${state}`;
}

// Who or what a visitor needs from each trade, as the closing band asks it.
const NEED: Record<Exclude<Trade, "other">, string> = {
  plumbing: "a plumber",
  hvac: "heating or cooling help",
  electrical: "an electrician",
  roofing: "a roofer",
  cleaning: "a cleaner",
  landscaping: "a landscaper",
  it: "IT help",
  law: "legal help",
};

/**
 * "Need a plumber in Austin?": the owner's trade and home town, and nothing else, as a question. The owner's own
 * business type comes first, which needs no article, capitalised as it starts the question: "Bakery in Boston?".
 */
export const needQuestion = (facts: Facts): string =>
  facts.trade === "other" ? `${tradeLabel(facts)} in ${facts.location.city}?` : `Need ${NEED[facts.trade]} in ${facts.location.city}?`;

// What to tell the business, on the services' call-to-action card under "Not sure which service you need?": the trades
// speak of a job; an IT firm of a project, a law firm of the visitor's matter, any other business in words that fit any.
const ASK_ABOUT: Readonly<Record<Trade, string>> = {
  plumbing: "Tell us about the job.",
  hvac: "Tell us about the job.",
  electrical: "Tell us about the job.",
  roofing: "Tell us about the job.",
  cleaning: "Tell us about the job.",
  landscaping: "Tell us about the job.",
  it: "Tell us about the project.",
  law: "Tell us about your legal matter.",
  other: "Tell us what you have in mind.",
};

/** "Tell us about the job.", in the words of the owner's trade. */
export const askAbout = (facts: Pick<Facts, "trade">): string => ASK_ABOUT[facts.trade];

/** "Boise, ID" or "Boise, ID and Meridian": one or two places as words, the home town with its state. */
export function fewPlaces(facts: Facts): string {
  const { city, state } = facts.location;
  const { places } = shownArea(facts);
  return places.map((place) => (place.trim().toLowerCase() === city.trim().toLowerCase() ? `${place}, ${state}` : place)).join(" and ");
}

/**
 * The service area in a few words, for the no-photo hero's card: one or two places as the section says them
 * ("Boise, ID"), three by name ("Kyle, Austin and Buda"), more as the first two and a count ("Austin, Round Rock
 * and 5 more"; the section lists them all).
 */
export function areaSummary(facts: Facts): string {
  const { places } = shownArea(facts);
  if (places.length <= 2) return fewPlaces(facts);
  if (places.length === 3) return `${places[0]}, ${places[1]} and ${places[2]}`;
  return `${places[0]}, ${places[1]} and ${places.length - 2} more`;
}

/** "Serving Austin, Round Rock and 5 more", or the owner's scope in its place: "Serving customers nationwide". */
export const servingText = (facts: Facts): string => scopeLine(facts) ?? `Serving ${areaSummary(facts)}`;

/** The home town line: "Austin, TX 78745". */
export function cityLine(facts: Facts): string {
  const { city, state, postalCode } = facts.location;
  return `${city}, ${state}${postalCode === undefined ? "" : ` ${postalCode}`}`;
}
