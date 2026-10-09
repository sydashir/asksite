import { DAYS, serviceAreaScopeOf, type Day, type Facts, type OpeningHours, type Trade } from "@asksite/site-schema";
import { safeUrl, type SafeUrl } from "./html.ts";

/** The name of each trade the site shows; "other" shows the owner's own words instead (tradeLabel). */
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

/** The trade as the site names it: "Plumbing", "Law firm", or for "other" the owner's own business type ("Bakery"). */
export function tradeLabel(facts: Pick<Facts, "trade" | "tradeOther">): string {
  if (facts.trade !== "other") return TRADE_LABEL[facts.trade];
  // Facts requires tradeOther exactly when the trade is "other", and render() parses every document first.
  if (facts.tradeOther === undefined) throw new Error("A business whose trade is other names its own business type");
  return facts.tradeOther;
}

/**
 * "Plumbing services", "Bakery services": a trade's name before "services", which needs no article whatever the owner
 * wrote. A name that already ends in "service" or "services" ("Pool service") is not given a second one.
 */
export const servicesOf = (label: string): string => (/\bservices?$/i.test(label) ? label : `${label} services`);

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

/** "+15125550142" -> "(512) 555-0142". Input is already validated as US E.164. */
export function formatPhone(e164: string): string {
  const d = e164.slice(2);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** RFC 3966 global number: tel:+15125550142. */
export function telUrl(e164: string): SafeUrl {
  return safeUrl(`tel:${e164}`, ["tel:"]);
}

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
