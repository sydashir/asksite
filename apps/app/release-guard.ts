import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertDeployableSiteKey } from "./build-config.ts";

// Run by `release` before anything is built or deployed (F31): refuses to ship a Worker whose Turnstile sitekey is
// empty (nobody could sign in) or one of Cloudflare's dummy keys (accepted from any domain).
// Usage: node release-guard.ts [wrangler config]   (default: ./wrangler.jsonc, the production config)
// Exit 0: the sitekey can be deployed; 1: it cannot.
const path = process.argv[2] ?? fileURLToPath(new URL("./wrangler.jsonc", import.meta.url));
const { vars } = JSON.parse(readFileSync(path, "utf8")) as { vars?: Record<string, string> };
try {
  assertDeployableSiteKey(vars?.["TURNSTILE_SITE_KEY"] ?? "");
} catch (err) {
  console.error(err instanceof Error ? err.message : "The release guard refused this config");
  process.exitCode = 1;
}
