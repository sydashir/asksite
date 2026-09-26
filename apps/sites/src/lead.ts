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
  phone: "Please enter a phone number we can call back, with at least 7 digits.",
  email: "Please check your email address, or leave it empty.",
  service: "Please choose a service from the list.",
  message: "Please shorten your message to 2,000 characters or fewer.",
};

// Control characters, and invisible formatting characters (e.g. U+202E, which can make a name
// read backwards in the owner's inbox). U+200D stays so emoji in names survive.
const HIDDEN = /\p{Cc}|(?!\u200D)\p{Cf}/gu;
const HIDDEN_EXCEPT_NEWLINE = /(?!\n)\p{Cc}|(?!\u200D)\p{Cf}/gu;
const PHONE = /^[0-9+().\- ]{7,30}$/;
const Email = z.email().max(254);

/** Removes hidden characters and trims. Messages keep line breaks (CRLF from the browser becomes LF). */
function clean(value: string | null, keepNewlines: boolean): string {
  const text = (value ?? "").replace(/\r\n?/g, "\n");
  return text.replace(keepNewlines ? HIDDEN_EXCEPT_NEWLINE : HIDDEN, "").trim();
}

export function readLead(fields: URLSearchParams): { ok: true; lead: Lead } | { ok: false; problems: LeadProblem[] } {
  const name = clean(fields.get("name"), false);
  const phone = clean(fields.get("phone"), false);
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
