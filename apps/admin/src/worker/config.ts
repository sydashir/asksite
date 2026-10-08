import { logLine } from "@asksite/app-common";

/** A11's default for LOGIN_EMAILS_PER_DAY, the same as the owner app's (apps/app/src/worker/config.ts). */
const LOGIN_EMAILS_PER_DAY_DEFAULT = 40;

/**
 * LOGIN_EMAILS_PER_DAY as a whole number above 0, written in digits only, read exactly as the owner app reads
 * it (apps/app/src/worker/config.ts): the admin must show the cap the app enforces. Anything else logs one
 * config_invalid line naming the variable (never its value) and gives the default.
 */
export function loginEmailsPerDay(value: string | undefined): number {
  const cap = value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : 0;
  if (Number.isSafeInteger(cap) && cap > 0) return cap;
  logLine({ event: "config_invalid", variable: "LOGIN_EMAILS_PER_DAY" });
  return LOGIN_EMAILS_PER_DAY_DEFAULT;
}
