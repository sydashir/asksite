import { logConfigInvalid } from "./log.ts";

/** A11c's default for LEAD_EMAILS_PER_DAY: with sign-in's 40, Resend Free's 100 a day keeps 20 for the rest. */
const LEAD_EMAILS_PER_DAY_DEFAULT = 40;

/**
 * LEAD_EMAILS_PER_DAY as a whole number above 0, written in digits only (as Plan 4 reads
 * LOGIN_EMAILS_PER_DAY). Anything else (missing, empty, "abc", "0", "-3", "1.5", or too large to be
 * exact) would make the day's cap 0, NaN or Infinity; D1 binds NaN and Infinity as NULL, and either way
 * every lead email would stop without a word. So it logs one config_invalid line naming the variable
 * (never its value) and uses the default.
 */
export function leadEmailsPerDay(value: string | undefined): number {
  const cap = value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : 0;
  if (Number.isSafeInteger(cap) && cap > 0) return cap;
  logConfigInvalid("LEAD_EMAILS_PER_DAY");
  return LEAD_EMAILS_PER_DAY_DEFAULT;
}
