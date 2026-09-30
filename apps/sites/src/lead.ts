import { z } from "zod";

// The contact form's fields, exactly as Plan 1 Task 13 names them: name, phone, email, service,
// message, and the honeypot "website". Checked here in plain words; nothing typed is ever echoed.

export interface Lead {
  name: string;
  phone: string;
  email: string | null;
  service: string | null;
  message: string | null;
}

export type LeadProblem = "name" | "phone" | "email" | "service" | "message";

export const PROBLEM_TEXT: Record<LeadProblem, string> = {
  name: "Please enter your name (up to 80 characters).",
  phone: "Please enter a phone number we can call back, with at least 7 digits. Use only digits, spaces, dashes, dots, parentheses and a plus sign, and leave out any extension.",
  email: "Please check your email address, or leave it empty.",
  service: "Please choose a service from the list.",
  message: "Please shorten your message to 2,000 characters or fewer.",
};

// Every form of line break: CRLF and a lone CR (browsers send CRLF), vertical tab, form feed, and the line
// and paragraph separators U+2028 and U+2029 (Zl, Zp), which some mail clients break a subject line at (A15).
const LINE_BREAK = /\r\n?|[\v\f\u2028\u2029]/g;
// Control characters other than "\n", and invisible formatting characters (e.g. U+202E, which can make a
// name read backwards in the owner's inbox). U+200D stays so emoji in names survive.
const HIDDEN = /(?!\n)\p{Cc}|(?!\u200D)\p{Cf}/gu;
const PHONE = /^[0-9+().\- ]{7,30}$/;
const Email = z.email().max(254);

/**
 * Trims, and removes hidden characters without gluing words together (QA-2 QS(2)): a tab becomes a
 * space, and a line break a newline in the message or a space in a one-line field, so no line break
 * ever reaches a one-line field (the name goes into the lead email's subject).
 */
function clean(value: string | null, keepNewlines: boolean): string {
  const text = (value ?? "").replace(LINE_BREAK, "\n").replaceAll("\t", " ");
  return (keepNewlines ? text : text.replaceAll("\n", " ")).replace(HIDDEN, "").trim();
}

// A number pasted from a web page or a contact card often holds typographic spaces and dashes (QA-2
// QS(1)): every Unicode space separator (Zs, e.g. U+00A0, U+202F), and the hyphens and dashes U+2010-U+2015,
// U+2212 (minus), U+FE58, U+FE63 and U+FF0D. They become an ASCII space or "-" before the phone rule.
const TYPOGRAPHIC_SPACE = /\p{Zs}/gu;
const TYPOGRAPHIC_DASH = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
const plainPhone = (phone: string): string => phone.replace(TYPOGRAPHIC_SPACE, " ").replace(TYPOGRAPHIC_DASH, "-");

export function readLead(fields: URLSearchParams): { ok: true; lead: Lead } | { ok: false; problems: LeadProblem[] } {
  const name = clean(fields.get("name"), false);
  const phone = plainPhone(clean(fields.get("phone"), false));
  const email = clean(fields.get("email"), false);
  const service = clean(fields.get("service"), false);
  const message = clean(fields.get("message"), true);

  const problems: LeadProblem[] = [];
  if (name.length < 1 || name.length > 80) problems.push("name");
  if (!PHONE.test(phone) || (phone.match(/\d/g) ?? []).length < 7) problems.push("phone");
  if (email !== "" && !Email.safeParse(email).success) problems.push("email");
  if (service.length > 60) problems.push("service");
  if (message.length > 2000) problems.push("message");
  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    lead: { name, phone, email: email || null, service: service || null, message: message || null },
  };
}

/** More than 3 "http" in the message: stored as spam, not emailed. */
export const looksLikeSpam = (lead: Lead): boolean => ((lead.message ?? "").match(/http/gi) ?? []).length > 3;
