// Page rules of the Bold design (A12, design id "impact"), ported from the approved mockup's generator
// (bold-v2 round 4, _work/build.py). Each is a pure function of the document, so the tests pin them.
import { DAYS, type Day, type Facts, type OpeningHours, type SectionId } from "@asksite/site-schema";
import { formatTime } from "../../format.ts";

const NBSP = " ";

/** Character count as a reader sees it (code points, not UTF-16 units). */
const length = (text: string) => [...text].length;

/** The h1's whole class list, picked by the headline's length: caps up to 40 characters, then two mixed-case steps. */
export function headlineClass(headline: string): "h1 display" | "h1 display h1--long" | "h1 display h1--xlong" {
  const n = length(headline);
  if (n <= 40) return "h1 display";
  return n <= 60 ? "h1 display h1--long" : "h1 display h1--xlong";
}

/** A word this long can reach a line's end on a 320 px phone; overflow-wrap still breaks any part too wide for its line. */
const LONG_WORD = 16;

/**
 * `text` cut where a long email or web address may break, as the owner typed it: after "@", and before each "."
 * that a letter or digit follows (MDN <wbr>: break a web address before its punctuation, so no line ends on a dot
 * a reader could take for the end). Only words of 16 or more characters are cut, so a name's own dots ("J.R.",
 * "Co.") never become break points. The parts joined give `text` back.
 */
export function addressParts(text: string): string[] {
  const parts = [""];
  for (const word of text.split(/(\s+)/)) {
    const pieces = length(word) >= LONG_WORD ? word.split(/(?<=@)(?=\S)|(?<=\S)(?=\.[\p{L}\p{N}])/u) : [word];
    parts[parts.length - 1] += pieces[0] ?? "";
    parts.push(...pieces.slice(1));
  }
  return parts;
}

/** An inner page's title (its <h1>, A16): capitals up to 40 characters, then a mixed-case step ("About" and a long name). */
export function pageTitleClass(title: string): "pt display" | "pt display pt--long" {
  return length(title) <= 40 ? "pt display" : "pt display pt--long";
}

/** A business name over 28 characters gets the smaller brand size (the schema allows 60). */
export const brandClass = (name: string): "brand" | "brand brand--long" => (length(name) > 28 ? "brand brand--long" : "brand");

// Advance widths (em) of the capital letters, digits and punctuation a button label can hold, the widest of the
// three display faces measured in the mockup (Archivo Condensed ExtraBold, SF condensed, Roboto wdth 75 at 800;
// bold-v2 r4 _work/metrics.json, Chromium). Any other character counts as the widest glyph measured.
const ADVANCE: Readonly<Record<string, number>> = {
  " ": 0.2305, "!": 0.293, '"': 0.4307, "#": 0.5605, $: 0.5654, "%": 0.8, "&": 0.63, "'": 0.2505, "(": 0.368, ")": 0.368,
  "*": 0.4595, "+": 0.5654, ",": 0.2568, "-": 0.3906, ".": 0.2969, "/": 0.3208, "0": 0.5786, "1": 0.5083, "2": 0.52, "3": 0.5508,
  "4": 0.5688, "5": 0.542, "6": 0.5659, "7": 0.5083, "8": 0.5713, "9": 0.5659, ":": 0.2822, ";": 0.2666, "?": 0.4863, "@": 0.791,
  A: 0.6045, B: 0.572, C: 0.6016, D: 0.605, E: 0.537, F: 0.479, G: 0.629, H: 0.6221, I: 0.2749, J: 0.5015, K: 0.593, L: 0.484,
  M: 0.7588, N: 0.6118, O: 0.634, P: 0.5718, Q: 0.634, R: 0.584, S: 0.5449, T: 0.5488, U: 0.6001, V: 0.5967, W: 0.8398, X: 0.6011,
  Y: 0.5762, Z: 0.538, "\u2013": 0.541, "\u2014": 0.7588, "\u2019": 0.2329, "\u201c": 0.4175, "\u201d": 0.4175, "\u2026": 0.755,
};
const WIDEST = 0.8398;
const TRACKING = 0.025; // em between capitals on a button
const FIT_MARGIN = 1.03; // kerning and rounding

// The narrowest content box, in px, of each button that shows the owner's call-to-action label, with its font
// size in px (impact.css): the hero pair at 64rem, the header button, the services card (and Home's) from 64rem, and
// the closing band's button at 320 px (A16; the band is 288 px inside there, less 0.75rem padding and the border).
// Wider ones need no slot: the inner page head's from 64rem, the phone menu's and Contact's head button at 320 px
// (18 px, as the closing band's, or 17 px in the menu).
const LABEL_SLOTS = [
  { width: 455, size: 20 },
  { width: 240, size: 17 },
  { width: 274, size: 20 },
  { width: 260, size: 18 },
] as const;

/** Width in px of `label` in capitals at `size` px. */
export function capsWidth(label: string, size: number): number {
  const caps = [...label.toUpperCase()];
  return caps.reduce((sum, ch) => sum + (ADVANCE[ch] ?? WIDEST) * size, 0) + TRACKING * size * caps.length;
}

/**
 * One case for every button on the page: capitals when the owner's call-to-action label fits one line in
 * capitals in every button that shows it, else sentence case on every button, so a page never mixes the two.
 */
export function buttonCase(ctaText: string): "caps" | "sentence" {
  return LABEL_SLOTS.every(({ width, size }) => capsWidth(ctaText, size) * FIT_MARGIN <= width) ? "caps" : "sentence";
}

// A one-word label is fine on a button ("Book") but reads as a bare template label as a heading.
const ONE_WORD_HEADING: Readonly<Record<string, string>> = {
  book: "Request a booking",
  quote: "Request a quote",
  estimate: "Request an estimate",
  schedule: "Request a visit",
  contact: "Send us a request",
  enquire: "Send us a request",
  inquire: "Send us a request",
  call: "Send us a request",
};

/** The contact section's heading: the owner's label when it has two or more words, else a fuller fixed heading. */
export function contactHeading(cta: string): string {
  const label = cta.trim();
  if (label.split(/\s+/).length >= 2) return label;
  const key = label.replace(/[.!]+$/, "").toLowerCase();
  return ONE_WORD_HEADING[key] ?? "Send us a request";
}

const SHORT_DAY: Readonly<Record<Day, string>> = {
  Monday: "Mon",
  Tuesday: "Tue",
  Wednesday: "Wed",
  Thursday: "Thu",
  Friday: "Fri",
  Saturday: "Sat",
  Sunday: "Sun",
};

/** "7:00 AM – 7:00 PM": no-break spaces inside each time and before the dash, so a line breaks only after the dash. */
function dayValue(hours: readonly OpeningHours[], day: Day): string {
  const entry = hours.find((h) => h.days.includes(day));
  if (entry === undefined) return "Closed";
  if (entry.opens === "00:00" && entry.closes === "23:59") return `Open 24${NBSP}hours`;
  const time = (hhmm: string) => formatTime(hhmm).replace(" ", NBSP);
  return `${time(entry.opens)}${NBSP}– ${time(entry.closes)}`;
}

export interface HoursRow {
  readonly label: string;
  readonly value: string;
}

/** Consecutive days with the same hours as one row ("Monday – Friday"), Monday first; days without hours are "Closed". */
export function groupedHours(hours: readonly OpeningHours[], short = false): HoursRow[] {
  const rows: Array<{ days: Day[]; value: string }> = [];
  for (const day of DAYS) {
    const value = dayValue(hours, day);
    const last = rows.at(-1);
    if (last !== undefined && last.value === value) last.days.push(day);
    else rows.push({ days: [day], value });
  }
  return rows.map(({ days, value }) => {
    const names = days.map((d) => (short ? SHORT_DAY[d] : d));
    const label = names.length === 1 ? (names[0] ?? "") : `${names[0] ?? ""}${NBSP}–${NBSP}${names.at(-1) ?? ""}`;
    return { label, value };
  });
}

/**
 * A licence as the page shows it. When the number starts with a code the label repeats ("Arizona ROC" +
 * "ROC 999001"), the label drops that word, so the page never reads "ROC ROC". The number is never changed.
 */
export function licenceParts(licence: Facts["licences"][number]): { label: string; number: string } {
  const label = licence.label.trim();
  const number = licence.number.trim();
  const first = number.split(/\s+/)[0] ?? "";
  const prefix = /^([A-Za-z]+)(?=[\s#:-]|\d)/.exec(number)?.[1] ?? "";
  const codes = new Set([first, prefix].filter((code) => /[A-Za-z]/.test(code)).map((code) => code.toLowerCase()));
  const words = label.split(/\s+/);
  const hit = words.findIndex((word) => codes.has(word.toLowerCase()));
  return { label: hit === -1 ? label : words.filter((_, i) => i !== hit).join(" "), number };
}

/**
 * The gallery's layout by photo count, so every desktop row is complete: one photo alone; the first two side
 * by side (n % 3 == 2); a big first photo beside two stacked tiles (n % 3 == 0); the first across the full
 * width (n % 3 == 1).
 */
export function galleryClass(count: number): "gal gal--solo" | "gal gal--f1" | "gal gal--f2" | "gal gal--f3" {
  if (count === 1) return "gal gal--solo";
  const rest = count % 3;
  return rest === 2 ? "gal gal--f1" : rest === 0 ? "gal gal--f2" : "gal gal--f3";
}

/** The founded year's numeral class: a leading 1 or 2 is pulled left by its side bearing, so its ink starts on the heading edge. */
export const yearClass = (year: number): "year-n display" | "year-n display year-n--1" | "year-n display year-n--2" => {
  const lead = String(year).charAt(0);
  return lead === "1" ? "year-n display year-n--1" : lead === "2" ? "year-n display year-n--2" : "year-n display";
};

/**
 * One band of a page, in page order (A16): a section, Home's services preview, the ink head an inner page opens
 * with (its <h1>; drawn inside the page's first section), or the closing "Get in touch" band.
 */
export type Band = SectionId | "head" | "teaser" | "closing";

export type Surface = "ink" | "paper" | "tint";

/** Always ink: the hero, an inner page's head (every page opens on ink) and the contact band. */
const ALWAYS_INK: ReadonlySet<Band> = new Set<Band>(["hero", "head", "contact"]);

/** Ink unless the band above is ink: the reviews (the approved Home's ink band between two seams) and the closing band. */
const INK_AFTER_LIGHT: ReadonlySet<Band> = new Set<Band>(["testimonials", "closing"]);

/**
 * The surface of each band of one page, in page order. The hero, an inner page's head and the contact band are ink;
 * the reviews and the closing band are ink unless the band above is ink (so after ink reviews the closing band is
 * light and the two never merge into one dark block); the light bands alternate the page colour and the tint, so two
 * light neighbours never share a tone. A page holds at most two light bands in a row (the page map keeps pages
 * short; test/designs/impact checks every page shape). The footer below is the deeper ink.
 */
export function surfaces(flow: readonly Band[]): Map<Band, Surface> {
  const ink = new Set<Band>();
  flow.forEach((id, i) => {
    const above = flow[i - 1];
    if (ALWAYS_INK.has(id) || (INK_AFTER_LIGHT.has(id) && (above === undefined || !ink.has(above)))) ink.add(id);
  });
  const result = new Map<Band, Surface>();
  let light = 0;
  for (const id of flow) result.set(id, ink.has(id) ? "ink" : light++ % 2 === 0 ? "paper" : "tint");
  return result;
}

/**
 * The slanted seam where an ink band meets a light one, drawn by the LIGHT band: it reaches over the ink band's
 * edge, so no ink band (the contact band holds the form) forms a stacking context that would trap the Send
 * button under the call bar (styles/shared.css). "seam-up": the band above is ink (not the hero, whose own seam
 * is inside it); "seam-down": the band below is ink.
 */
export function seamClass(flow: readonly Band[], surface: ReadonlyMap<Band, Surface>, id: Band): "" | " seam-up" | " seam-down" | " seam-up seam-down" {
  if (surface.get(id) === "ink") return "";
  const i = flow.indexOf(id);
  const above = flow[i - 1];
  const below = flow[i + 1];
  const up = above !== undefined && above !== "hero" && surface.get(above) === "ink";
  const down = below !== undefined && surface.get(below) === "ink";
  return up && down ? " seam-up seam-down" : up ? " seam-up" : down ? " seam-down" : "";
}
