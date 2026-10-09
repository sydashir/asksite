import { DAYS, ServiceArea, type Day } from "@asksite/site-schema";
import { asArray, asRecord, asString, type Json } from "./values.ts";

// Converters between what the owner types and the facts the schema expects. Input that cannot
// be converted is stored as typed, so the Facts schema reports it and the field keeps its text.

/** "+15125550142" shows as "(512) 555-0142"; anything else shows as typed. */
export function phoneInput(value: unknown): string {
  const text = asString(value);
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(text);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : text;
}

/** 10 digits (or 11 starting with 1) become E.164; anything else is kept exactly as typed. */
export function phoneToFacts(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return input;
}

export function priceInput(value: unknown): string {
  return asString(value);
}

/**
 * "" removes the price; "$1,250" becomes 1250; anything else is kept as typed. A comma counts only as a
 * thousands separator: "1,25" is not 125, so it stays as typed and the schema reports it.
 */
export function priceToFacts(input: string): number | string | undefined {
  const trimmed = input.trim();
  if (trimmed === "") return undefined;
  const amount = trimmed.replace(/^\$/, "");
  const plain = /^\d{1,3}(,\d{3})+$/.test(amount) ? amount.replace(/,/g, "") : amount;
  return /^\d+$/.test(plain) ? Number(plain) : input;
}

/** Years in business as shown in the form, from the stored founding year (Plan 1 Decision #6). */
export function yearsInput(yearFounded: unknown, thisYear: number): string {
  return typeof yearFounded === "number" ? String(thisYear - yearFounded) : asString(yearFounded);
}

/** "" removes the fact; 0-175 years become a founding year; anything else is kept as typed. */
export function yearsToFacts(input: string, thisYear: number): number | string | undefined {
  const trimmed = input.trim();
  if (trimmed === "") return undefined;
  if (!/^\d+$/.test(trimmed)) return input;
  const years = Number(trimmed);
  return years <= thisYear - 1850 ? thisYear - years : input;
}

export interface DayRow {
  day: Day;
  open: boolean;
  opens: string;
  closes: string;
}

const DEFAULT_OPENS = "08:00";
const DEFAULT_CLOSES = "17:00";

/** One row per weekday, Monday first, from the stored opening-hours entries. */
export function hoursToRows(hours: unknown): DayRow[] {
  return DAYS.map((day) => {
    const entry = asArray(hours)
      .map(asRecord)
      .find((h) => asArray(h["days"]).includes(day));
    return entry === undefined
      ? { day, open: false, opens: DEFAULT_OPENS, closes: DEFAULT_CLOSES }
      : { day, open: true, opens: asString(entry["opens"]), closes: asString(entry["closes"]) };
  });
}

/** Open rows grouped by identical times, days in week order: the Facts `hours` shape. */
export function rowsToHours(rows: readonly DayRow[]): Array<{ days: Day[]; opens: string; closes: string }> {
  const groups: Array<{ days: Day[]; opens: string; closes: string }> = [];
  for (const row of rows) {
    if (!row.open) continue;
    const group = groups.find((g) => g.opens === row.opens && g.closes === row.closes);
    if (group) group.days.push(row.day);
    else groups.push({ days: [row.day], opens: row.opens, closes: row.closes });
  }
  return groups;
}

/** The weekdays of stored entry `index`, so an error on hours[index] can be shown on those rows. */
export function daysOfEntry(hours: unknown, index: number): Day[] {
  return asArray(asRecord(asArray(hours)[index])["days"]).filter((d): d is Day => (DAYS as readonly unknown[]).includes(d));
}

/** A web-address suggestion from the business name: "Joe's Plumbing & Drains" -> "joes-plumbing-drains". */
export function suggestSlug(businessName: unknown): string {
  return asString(businessName)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/** A gentle warning, never an error, for alt text that says nothing about the photo (§8 step 5). */
export function altTextWarning(alt: string): string | null {
  const text = alt.trim().toLowerCase();
  if (text === "") return null;
  if (/\.(jpe?g|png|webp|heic|gif)$/.test(text) || /^(img|dsc|pxl|image|photo)[_-]?\d+/.test(text)) {
    return "This looks like a file name. Say what the photo shows instead.";
  }
  if (/^(a |an |the )?(photo|picture|image|pic)\b/.test(text)) return "No need to start with “photo”: say what the photo shows.";
  return null;
}

/**
 * The service area to keep when the owner picks the whole country or worldwide (DECIDED 2026-10-09). The place list and the
 * note are hidden then but stay in the draft, so switching back to "In specific places" restores them. An entry that could
 * never be saved (empty, too long or with a hidden character) is dropped: hidden, it would block Build with no field to fix.
 * Checked with site-schema's own rules.
 */
export function keptServiceArea(area: unknown): Json {
  const { note, ...rest } = asRecord(area);
  const places = asArray(rest["places"]).filter((place) => ServiceArea.shape.places.element.safeParse(place).success);
  return { ...rest, places, ...(note !== undefined && ServiceArea.shape.note.safeParse(note).success ? { note } : {}) };
}
