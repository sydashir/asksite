import type { Env } from "./env.ts";
import { plainHeaders, rootHostname } from "./headers.ts";
import { notFound } from "./pages.ts";

/** RFC 9116 security.txt. Expires comes from SECURITY_TXT_EXPIRES, set at deploy time; if it is not
 *  a valid date the file is not served at all rather than served wrong. */
export function securityTxt(env: Env): Response {
  const expires = Date.parse(env.SECURITY_TXT_EXPIRES);
  if (Number.isNaN(expires)) return notFound(env.ROOT_DOMAIN);
  const body = `Contact: mailto:security@${rootHostname(env.ROOT_DOMAIN)}\nExpires: ${new Date(expires).toISOString()}\nPreferred-Languages: en\n`;
  return new Response(body, { headers: plainHeaders({ "Content-Type": "text/plain; charset=utf-8" }) });
}
