import { existsSync, readFileSync } from "node:fs";

// Build-time settings for the single-page app. The product domain is baked in, because the
// static _headers file (and its Content-Security-Policy) is generated at build time (§9.1).

const WORKER_CONFIG: Record<string, string> = {
  production: "./wrangler.jsonc",
  development: "./wrangler.jsonc",
  e2e: "./test/e2e/wrangler.e2e.jsonc",
};

/** The Worker config each Vite mode builds with. */
export function workerConfigPath(mode: string): string {
  const path = WORKER_CONFIG[mode];
  if (path === undefined) throw new Error(`Unknown build mode "${mode}"`);
  return path;
}

/** KEY=VALUE lines; blank lines and # comments ignored. */
export function parseDevVars(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] !== undefined && !line.trimStart().startsWith("#")) vars[match[1]] = (match[2] ?? "").replace(/^"(.*)"$/, "$1");
  }
  return vars;
}

/** The Worker variables the build will run with: the config's vars, plus .dev.vars in development mode. */
export function buildVars(mode: string, root: string): Record<string, string> {
  const config = JSON.parse(readFileSync(new URL(workerConfigPath(mode), root), "utf8")) as { vars: Record<string, string> };
  if (mode !== "development") return config.vars;
  const devVars = [".dev.vars", ".dev.vars.example"].map((name) => new URL(name, root)).find((url) => existsSync(url));
  return { ...config.vars, ...(devVars === undefined ? {} : parseDevVars(readFileSync(devVars, "utf8"))) };
}

/** The Worker name a development-mode build gets in its generated output config (F5). */
export const LOCAL_BUILD_WORKER_NAME = "asksite-app-local";

/**
 * F5: the development build runs on the production wrangler.jsonc, and `.wrangler/deploy/config.json` points a bare
 * `wrangler deploy` at the last build's output, so a development client (the dummy sitekey, no HSTS, img-src
 * media.localhost) could replace the production Worker. The output config of a development build therefore gets another
 * Worker name and loses its route and cron: such a deploy can only make a stray Worker nobody can reach, never replace
 * asksite-app. `release` (package.json) is the one deploy path: it guards the sitekey and builds production itself.
 */
export function undeployableLocalConfig(config: Record<string, unknown>): Record<string, unknown> {
  const { routes: _routes, triggers: _triggers, ...rest } = config;
  return { ...rest, name: LOCAL_BUILD_WORKER_NAME };
}

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** Cloudflare's documented dummy sitekeys: 1x/2x/3x, twenty zeros, then AA, AB, BB or FF (Turnstile "testing" page). */
const DUMMY_SITE_KEY = /^[123]x0{20}[A-F]{2}$/;

/**
 * Throws unless `key` is a real Turnstile sitekey: an empty one leaves the sign-in form without a widget
 * and a dummy one is accepted from any domain. Task 27's deploy step runs this on the production
 * TURNSTILE_SITE_KEY; builds do not, because the e2e and size builds use the dummy key (M3).
 */
export function assertDeployableSiteKey(key: string): void {
  if (key === "" || DUMMY_SITE_KEY.test(key)) throw new Error("TURNSTILE_SITE_KEY must be the real Turnstile sitekey, not empty or one of Cloudflare's dummy keys");
}

/** The §9.1 app policy, with this build's media host. */
export function contentSecurityPolicy(rootDomain: string): string {
  return [
    "default-src 'self'",
    // Turnstile's widget (docs: developers.cloudflare.com/turnstile/reference/content-security-policy/): the
    // script and its frame. The static _headers file cannot carry a nonce, so the host is listed.
    `script-src 'self' ${TURNSTILE_ORIGIN}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' https://media.${rootDomain} blob: data:`,
    "connect-src 'self'",
    `frame-src 'self' ${TURNSTILE_ORIGIN}`,
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Static Assets _headers: applies to every file of the app (not to Worker responses, §9.1). HSTS only
 * in a production build: from a localhost host it would force https onto every local project (Plan 2 decision 8).
 */
export function headersFile(rootDomain: string, production: boolean): string {
  return [
    "/*",
    `  Content-Security-Policy: ${contentSecurityPolicy(rootDomain)}`,
    ...(production ? ["  Strict-Transport-Security: max-age=31536000; includeSubDomains"] : []),
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: no-referrer",
    "  X-Frame-Options: DENY",
    "  X-Robots-Tag: noindex",
    "",
  ].join("\n");
}
