import { DAYS, serviceAreaScopeOf, type Day, type Facts, type OpeningHours, type Trade } from "@asksite/site-schema";
import { safeUrl, type SafeUrl } from "./html.ts";

/** The name of each trade the site shows; "other" shows the owner's own words instead (tradeWords). */
export const TRADE_LABEL: Readonly<Record<Exclude<Trade, "other">, string>> = {
  plumbing: "Plumbing",
  hvac: "Heating & Cooling",
  electrical: "Electrical",
  roofing: "Roofing",
  cleaning: "Cleaning",
  landscaping: "Landscaping",
  it: "IT firm",
  law: "Law firm",
};

/** The trade as the site names it inside a sentence: "Plumbing", "Law firm", or for "other" the owner's own business type as typed ("bakery"). */
export function tradeWords(facts: Pick<Facts, "trade" | "tradeOther">): string {
  if (facts.trade !== "other") return TRADE_LABEL[facts.trade];
  // Facts requires tradeOther exactly when the trade is "other", and render() parses every document first.
  if (facts.tradeOther === undefined) throw new Error("A business whose trade is other names its own business type");
  return facts.tradeOther;
}

/**
 * The trade where it starts a line, heading or sentence ("Bakery · Seattle, WA", "Bakery in Seattle?"): tradeWords
 * with its first letter capitalised, so an owner's "bakery" reads "Bakery". A first word with a capital of its own is
 * a name and stays as typed ("iPhone repair", "eBay consignment"). The other trades' names already start with a capital.
 */
export const tradeLabel = (facts: Pick<Facts, "trade" | "tradeOther">): string =>
  tradeWords(facts).replace(/^\p{Ll}(?=[^\s\p{Lu}]*(?:\s|$))/u, (letter) => letter.toUpperCase());

/**
 * The label a law firm's site carries in its footer's small print, on every page. New York's Rule 7.1(f) asks for it on
 * a law firm's website (on the home page, NYSBA Ethics Opinion 848); rules differ by state, so this is the conservative
 * default, and the site claims no compliance with any rule. Fixed words, with no link, and no owner setting hides them.
 */
export const ATTORNEY_LINE = "Attorney Advertising";

/** ATTORNEY_LINE for a law firm; undefined for every other trade, "other" too, whatever the owner's own words. */
export const attorneyLine = (facts: Pick<Facts, "trade">): string | undefined => (facts.trade === "law" ? ATTORNEY_LINE : undefined);

/** "Plumbing services", "IT services", "Legal services": what a trade offers, for the Services page's description. */
export const servicesOf = (trade: Exclude<Trade, "other">): string => (trade === "it" ? "IT services" : trade === "law" ? "Legal services" : `${TRADE_LABEL[trade]} services`);

/** The line that stands in for the place list when the owner serves the whole country or the world. */
const SCOPE_LINE = { country: "Serving customers nationwide", worldwide: "Serving customers worldwide" } as const;

/** "Serving customers nationwide" or "Serving customers worldwide"; undefined while the owner serves listed places. */
export function scopeLine(facts: Pick<Facts, "serviceAreaScope">): string | undefined {
  const scope = serviceAreaScopeOf(facts);
  return scope === "places" ? undefined : SCOPE_LINE[scope];
}

/** The service area the site shows: the owner's places and note. */
export interface ShownArea {
  readonly places: readonly string[];
  readonly note: string | undefined;
}

const NO_AREA: ShownArea = { places: [], note: undefined };

/**
 * The owner's places and note while the scope is "places"; neither otherwise. Publishing drops both for the other
 * scopes, and a draft may keep them, so the site never shows them there: only the scope line.
 */
export function shownArea(facts: Pick<Facts, "serviceArea" | "serviceAreaScope">): ShownArea {
  return serviceAreaScopeOf(facts) === "places" ? { places: facts.serviceArea.places, note: facts.serviceArea.note } : NO_AREA;
}

// formatPhone and telUrl live in phone.ts (the cart markup's path); re-exported here for every other caller.
export { formatPhone, telUrl } from "./phone.ts";

export function mailtoUrl(email: string): SafeUrl {
  return safeUrl(`mailto:${email}`, ["mailto:"]);
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** 1250 -> "$1,250". */
export function formatPrice(dollars: number): string {
  return USD.format(dollars);
}

/** "08:00" -> "8:00 AM", "13:30" -> "1:30 PM", "00:00" -> "12:00 AM". */
export function formatTime(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "AM" : "PM";
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** One row per day, Monday first. Days without an entry are "Closed". */
export function weeklyHours(hours: readonly OpeningHours[]): Array<{ day: Day; time: string }> {
  return DAYS.map((day) => {
    const entry = hours.find((h) => h.days.includes(day));
    if (!entry) return { day, time: "Closed" };
    if (entry.opens === "00:00" && entry.closes === "23:59") return { day, time: "Open 24 hours" };
    return { day, time: `${formatTime(entry.opens)} – ${formatTime(entry.closes)}` };
  });
}
