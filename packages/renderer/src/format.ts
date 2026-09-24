import { DAYS, type Day, type OpeningHours, type Trade } from "@asksite/site-schema";
import { safeUrl, type SafeUrl } from "./html.ts";

export const TRADE_LABEL: Record<Trade, string> = {
  plumbing: "Plumbing",
  hvac: "Heating & Cooling",
  electrical: "Electrical",
  roofing: "Roofing",
  cleaning: "Cleaning",
  landscaping: "Landscaping",
};

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
