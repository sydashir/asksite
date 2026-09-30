// Response headers for everything served on customer hostnames (design §7.3, §7.4).

/** The host part of ROOT_DOMAIN, without a port: "localhost" for "localhost:8789". */
export const rootHostname = (root: string): string => root.replace(/:\d+$/, "");

/** HSTS is never sent for localhost: with includeSubDomains it would force https onto every local
 *  project on this machine (browsers apply HSTS per host, ignoring the port). */
const isLocal = (root: string): boolean => {
  const host = rootHostname(root);
  return host === "localhost" || host.endsWith(".localhost");
};

export const pageCsp = (root: string): string =>
  `default-src 'none'; style-src 'unsafe-inline'; img-src https://media.${root}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

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

/** An approved page. The only response without X-Robots-Tag, and only while the site is indexable. */
export function livePageHeaders(root: string, indexable: boolean): Headers {
  const headers = new Headers({ "Content-Type": HTML, "Cache-Control": "public, max-age=60", ...securityHeaders(root) });
  if (!indexable) headers.set("X-Robots-Tag", "noindex");
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
