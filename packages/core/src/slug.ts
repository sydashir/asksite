/** 3-40 characters of a-z and 0-9 with single hyphens inside: no "--", no leading or trailing "-". */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?!-)){1,38}[a-z0-9]$/;

/**
 * Names that can never be a site. They are our own hostnames, mail and DNS labels (any label with
 * its own DNS record escapes the "*" wildcard, so a site with that slug would have no address),
 * and words that would let a site pose as us. Plan 4 adds the brand and obscenity blocklist.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "www", "app", "admin", "media", "api", "mail", "email", "smtp", "imap", "pop", "ftp", "static",
  "assets", "cdn", "img", "images", "files", "status", "help", "support", "docs", "blog", "abuse",
  "security", "billing", "account", "accounts", "login", "signin", "signup", "auth", "dashboard",
  "staging", "stage", "dev", "test", "preview", "ns1", "ns2", "mx", "autodiscover", "autoconfig",
  "webmail", "send", "inbound", "bounce",
]);

/** Shape and reserved-word check only. */
export function slugIssue(slug: string): "invalid" | "reserved" | null {
  if (!SLUG_PATTERN.test(slug)) return "invalid";
  if (RESERVED_SLUGS.has(slug)) return "reserved";
  return null;
}
