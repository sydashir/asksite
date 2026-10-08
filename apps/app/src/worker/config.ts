import { logLine } from "@asksite/app-common";

/** A11's default for LOGIN_EMAILS_PER_DAY: most of Resend Free's 100 emails a day stay free for leads. */
const LOGIN_EMAILS_PER_DAY_DEFAULT = 40;

/**
 * LOGIN_EMAILS_PER_DAY as a whole number above 0, written in digits only. Anything else (missing, empty,
 * "abc", "0", "-3", "1.5", or too large to be exact) would make the day's cap 0, NaN or Infinity; D1 binds
 * NaN and Infinity as NULL, and either way every sign-in email would stop without a word. So it logs one
 * config_invalid line naming the variable (never its value) and uses the default.
 */
export function loginEmailsPerDay(value: string | undefined): number {
  const cap = value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : 0;
  if (Number.isSafeInteger(cap) && cap > 0) return cap;
  logLine({ event: "config_invalid", variable: "LOGIN_EMAILS_PER_DAY" });
  return LOGIN_EMAILS_PER_DAY_DEFAULT;
}
