import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertDeployableAccess } from "./build-config.ts";

// Run by `release` before anything is built or deployed (F5): refuses to ship a Worker whose Cloudflare Access settings
// are empty or in dev mode (no admin could sign in, or the dev bypass would be on). It names the field and never a value.
// Usage: node release-guard.ts [wrangler config]   (default: ./wrangler.jsonc, the production config)
// Exit 0: the admin can be deployed; 1: it cannot.
const path = process.argv[2] ?? fileURLToPath(new URL("./wrangler.jsonc", import.meta.url));
const { vars } = JSON.parse(readFileSync(path, "utf8")) as { vars?: Record<string, string> };
try {
  assertDeployableAccess(vars);
} catch (err) {
  console.error(err instanceof Error ? err.message : "The release guard refused this config");
  process.exitCode = 1;
}
