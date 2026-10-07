import type { ReviewChecks } from "@asksite/core";
import type { Facts } from "@asksite/site-schema";

// §3.2 text flags: owner facts are shown on our domain as text. Copy cannot contain links, "@",
// digits or phishing words (Plan 1), but facts can, so the reviewer is shown each fact string that does.
// Every free-text fact the page shows is checked, not only the design's examples: an address, a
// place or a licence number is as visible on the page as a review.

export type TextFlag = ReviewChecks["textFlags"][number];

/**
 * The text as a reader sees it (the same idea as amendment A2 for the claim checker): invisible characters
 * (\p{Default_Ignorable_Code_Point}, such as U+200D or U+034F inside a word) are dropped first, so they
 * cannot split a flagged word (A9); NFKC never produces one, so none is left after it. NFKC folds full-width
 * letters, digits and dots ("ｐａｙｐａｌ．ｃｏｍ"), and the ideographic full stop and the spelled-out dots
 * "[.]", "(.)", "(dot)", "[dot]" and " dot " read as ".". Matching only; nothing is stored or refused.
 */
const asRead = (text: string): string =>
  text
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .normalize("NFKC")
    .replace(/\u3002/g, ".")
    .replace(/\s*[\[({]\s*(?:\.|dot)\s*[\])}]\s*/giu, ".")
    .replace(/\s+dot\s+/giu, ".");

/** Any dotted name that ends in two or more letters (so .dev, .ai, .ru, .top too) or an xn-- label. */
const WEB_ADDRESS = /https?:\/\/|\bwww\.|(?<![\p{L}\p{N}-])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:\p{L}{2,}|xn--[a-z0-9-]+)(?![\p{L}\p{N}-])/iu;
const PHISHING_WORD = /\b(pass(word|code)|log ?in|sign ?in|verif(y|ication)|bank(ing)?|gift ?cards?|crypto|bitcoin|wire|ssn|social security)\b/i;
/** Digits in any script, with spaces, brackets, dots or any dash between the groups. */
const PHONE_LIKE = /\+?\p{Nd}[\p{Nd}\s().\p{Pd}]{5,}\p{Nd}/gu;

/** The digits of a phone-like run; other scripts' digits stay as they are, so they never equal the site's own number. */
const digits = (text: string): string => [...text.matchAll(/\p{Nd}/gu)].map((m) => m[0]).join("").replace(/^1(?=\d{10}$)/, "");

/** Every owner-typed text fact, with its path. */
function factStrings(facts: Facts): Array<[string, string]> {
  const out: Array<[string, string]> = [["businessName", facts.businessName]];
  if (facts.location.streetAddress !== undefined) out.push(["location.streetAddress", facts.location.streetAddress]);
  out.push(["location.city", facts.location.city]);
  facts.services.forEach((s, i) => out.push([`services.${i}.name`, s.name]));
  facts.serviceArea.places.forEach((place, i) => out.push([`serviceArea.places.${i}`, place]));
  if (facts.serviceArea.note !== undefined) out.push(["serviceArea.note", facts.serviceArea.note]);
  facts.licences.forEach((l, i) => out.push([`licences.${i}.label`, l.label], [`licences.${i}.number`, l.number]));
  facts.testimonials.forEach((t, i) => {
    out.push([`testimonials.${i}.quote`, t.quote], [`testimonials.${i}.name`, t.name]);
    if (t.location !== undefined) out.push([`testimonials.${i}.location`, t.location]);
  });
  const photos = [...(facts.heroPhoto === undefined ? [] : [["heroPhoto", facts.heroPhoto] as const]), ...facts.photos.map((p, i) => [`photos.${i}`, p] as const)];
  for (const [path, photo] of photos) {
    out.push([`${path}.alt`, photo.alt]);
    if (photo.caption !== undefined) out.push([`${path}.caption`, photo.caption]);
  }
  return out;
}

export function textFlags(facts: Facts): TextFlag[] {
  const own = digits(facts.phone);
  const flags: TextFlag[] = [];
  for (const [field, typed] of factStrings(facts)) {
    const path = `facts.${field}`;
    const text = asRead(typed);
    if (WEB_ADDRESS.test(text)) flags.push({ path, reason: "web_address" });
    if (text.includes("@")) flags.push({ path, reason: "at_sign" });
    if ([...text.matchAll(PHONE_LIKE)].some((m) => digits(m[0]).length >= 7 && digits(m[0]) !== own)) flags.push({ path, reason: "other_phone" });
    if (PHISHING_WORD.test(text)) flags.push({ path, reason: "phishing_word" });
  }
  return flags;
}
