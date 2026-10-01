// The admin app's static headers. The owner app's build-config.ts supplies everything else (vite.config.ts imports
// buildVars and workerConfigPath from it); the admin has its own document policy because it differs in two ways:
// it never loads Turnstile, and its review screen shows the stored page in a srcdoc iframe, which inherits this
// policy, so the page's Bold font (a data: URI) needs font-src data:.

import { undeployableLocalConfig as withoutRoutes } from "../app/build-config.ts";
import { allowlist } from "./src/worker/access.ts";

/** The Worker name a development-mode build gets in its generated output config (F5). */
export const LOCAL_BUILD_WORKER_NAME = "asksite-admin-local";

/**
 * F5: the development build runs on the production wrangler.jsonc, and `.wrangler/deploy/config.json` points a bare
 * `wrangler deploy` at the last build's output, so a development build (ADMIN_AUTH_MODE and the dev admin of a local
 * .dev.vars, no HSTS) could replace the production Worker. The output config of a development build therefore gets
 * another Worker name and loses its route: such a deploy can only make a stray Worker nobody can reach, never replace
 * asksite-admin. The owner app's function drops the routes and triggers; only the name is the admin's own.
 */
export function undeployableLocalConfig(config: Record<string, unknown>): Record<string, unknown> {
  return { ...withoutRoutes(config), name: LOCAL_BUILD_WORKER_NAME };
}

const ACCESS_TEAM_DOMAIN = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;

/**
 * Throws unless the production Worker vars let an admin sign in (F5): Access mode (never "dev"), an audience, a team
 * domain of the shape the issuer pin expects (F6), at least one allowed email as the worker reads the list, and no dev
 * admin. The production config ships the Access values empty until Task 27, and an admin deployed that way refuses
 * everyone (F9), so `release` runs this first. The messages name a field and never carry a value.
 */
export function assertDeployableAccess(vars: Record<string, string> | undefined): void {
  const v = vars ?? {};
  if (v["ADMIN_AUTH_MODE"] !== "access") throw new Error('ADMIN_AUTH_MODE must be "access" before a release');
  if ((v["ACCESS_AUD"] ?? "") === "") throw new Error("ACCESS_AUD must be set before a release");
  if (!ACCESS_TEAM_DOMAIN.test(v["ACCESS_TEAM_DOMAIN"] ?? "")) throw new Error("ACCESS_TEAM_DOMAIN must be set before a release, as https://<team>.cloudflareaccess.com");
  if (allowlist(v["ADMIN_EMAILS"] ?? "").length === 0) throw new Error("ADMIN_EMAILS must be set before a release, with at least one email");
  if ((v["DEV_ADMIN_EMAIL"] ?? "") !== "") throw new Error("DEV_ADMIN_EMAIL must be empty before a release");
}

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
