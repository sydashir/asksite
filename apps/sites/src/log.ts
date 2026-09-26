/** One structured line per request or cron run. IDs and codes only: never IPs, emails, tokens,
 *  lead content or keys (invocation logs are off, so this is the whole log). */
export function logLine(fields: { route: string; status?: number; ms: number; siteId?: string; code?: string; deleted?: number }): void {
  console.log(JSON.stringify({ worker: "asksite-sites", ...fields }));
}
