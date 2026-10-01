// Response headers for everything served on customer hostnames (design §7.3, §7.4).

/** The host part of ROOT_DOMAIN, without a port: "localhost" for "localhost:8789". */
export const rootHostname = (root: string): string => root.replace(/:\d+$/, "");

/** HSTS is never sent for localhost: with includeSubDomains it would force https onto every local
 *  project on this machine (browsers apply HSTS per host, ignoring the port). */
const isLocal = (root: string): boolean => {
  const host = rootHostname(root);
  return host === "localhost" || host.endsWith(".localhost");
};

// font-src data: only: Bold (impact) embeds its heading font as a data: URI inside its sheet (user decision
// 2026-09-27); no page loads a font from anywhere else.
export const pageCsp = (root: string): string =>
  `default-src 'none'; style-src 'unsafe-inline'; img-src https://media.${root}; font-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

function securityHeaders(root: string): Record<string, string> {
  return {
    "Content-Security-Policy": pageCsp(root),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    ...(isLocal(root) ? {} : { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" }),
  };
}

const HTML = "text/html; charset=utf-8";

const BROWSER_CACHE = "no-cache";

/**
 * An approved page. The only response without X-Robots-Tag, and only while the site is indexable. Browsers must
 * revalidate on every view ("no-cache"): a page cached by a browser could otherwise sit next to a newer one (U2),
 * and the revalidation goes through the pointer, which names the live version.
 */
export function livePageHeaders(root: string, indexable: boolean): Headers {
  const headers = new Headers({ "Content-Type": HTML, "Cache-Control": BROWSER_CACHE, ...securityHeaders(root) });
  if (!indexable) headers.set("X-Robots-Tag", "noindex");
  return headers;
}

/**
 * The same headers for the copy kept in this data centre's cache: Cloudflare does not cache a response marked
 * no-cache, and s-maxage sets the edge's TTL (developers.cloudflare.com/workers/runtime-apis/cache/ and
 * /cache/concepts/cache-control/). The copy is only ever read back through a key that carries the version id.
 */
export function edgeCopyHeaders(live: Headers): Headers {
  const headers = new Headers(live);
  headers.set("Cache-Control", "public, s-maxage=60");
  return headers;
}

/** A cached copy's headers as the browser gets them: the same as a fresh page's. */
export function browserCopyHeaders(edge: Headers): Headers {
  const headers = new Headers(edge);
  headers.set("Cache-Control", BROWSER_CACHE);
  return headers;
}

/** Fixed pages (404, 503, thank-you, form errors, apex): never cached, never indexed. */
export function fixedPageHeaders(root: string): Headers {
  return new Headers({ "Content-Type": HTML, "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...securityHeaders(root) });
}

/** Photos: a day in browsers, 5 minutes at the edge (s-maxage wins for Cloudflare's cache), so a
 *  takedown stops them at the edge within 5 minutes. The type is always set here, never taken from R2. */
export function mediaHeaders(): Headers {
  return new Headers({
    "Content-Type": "image/webp",
    "Cache-Control": "public, max-age=86400, s-maxage=300",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Robots-Tag": "noindex",
  });
}

/** Redirects and plain-text answers. */
export function plainHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff", ...extra });
}
