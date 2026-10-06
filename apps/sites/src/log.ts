/** One structured line per request or cron run. IDs and codes only: never IPs, emails, tokens,
 *  lead content or keys (invocation logs are off, so this is the whole log). The cron's fields are counts and bytes. */
export function logLine(fields: { route: string; status?: number; ms: number; siteId?: string; code?: string; deleted?: number; deletedSpam?: number; deletedExpired?: number; dbBytes?: number }): void {
  console.log(JSON.stringify({ worker: "asksite-sites", ...fields }));
}

/** A variable the Worker cannot use, so it runs on the default: names the variable, never its value. */
export function logConfigInvalid(variable: string): void {
  console.log(JSON.stringify({ worker: "asksite-sites", event: "config_invalid", variable }));
}
