// The admin app's static headers. The owner app's build-config.ts supplies everything else (vite.config.ts imports
// buildVars and workerConfigPath from it); the admin has its own document policy because it differs in two ways:
// it never loads Turnstile, and its review screen shows the stored page in a srcdoc iframe, which inherits this
// policy, so the page's Bold font (a data: URI) needs font-src data:.

/** The §9.1 admin policy, with this build's media host. */
export function adminContentSecurityPolicy(rootDomain: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' https://media.${rootDomain} blob: data:`,
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Static Assets _headers for the admin SPA. HSTS only in a production build: from a localhost host it would force https onto every local project (Plan 2 decision 8). */
export function adminHeadersFile(rootDomain: string, production: boolean): string {
  return [
    "/*",
    `  Content-Security-Policy: ${adminContentSecurityPolicy(rootDomain)}`,
    ...(production ? ["  Strict-Transport-Security: max-age=31536000; includeSubDomains"] : []),
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: no-referrer",
    "  X-Frame-Options: DENY",
    "  X-Robots-Tag: noindex",
    "",
  ].join("\n");
}
