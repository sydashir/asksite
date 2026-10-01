import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertDeployableAccess } from "./build-config.ts";

// Run by `release` before anything is built or deployed (F5): refuses to ship a Worker whose Cloudflare Access settings
// are empty or in dev mode (no admin could sign in, or the dev bypass would be on). It names the field and never a value.
// Usage: node release-guard.ts [wrangler config]   (default: ./wrangler.jsonc, the production config)
// Exit 0: the admin can be deployed; 1: it cannot.
const path = process.argv[2] ?? fileURLToPath(new URL("./wrangler.jsonc", import.meta.url));
// Reading and parsing get their own try: a config that is not plain JSON (a `//` comment, say) must give one fixed
// message, never the parser's error, which quotes the offending line (an email or the audience tag).
let vars: Record<string, unknown> | undefined;
let readable = true;
try {
  ({ vars } = JSON.parse(readFileSync(path, "utf8")) as { vars?: Record<string, unknown> });
} catch {
  readable = false;
}
// process.exitCode, not process.exit: exit can drop stderr that is still being written (Node docs).
if (!readable) {
  console.error("The release guard could not read the wrangler config as JSON; fix the file and run the release again");
  process.exitCode = 1;
} else {
  try {
    assertDeployableAccess(vars);
  } catch (err) {
    console.error(err instanceof Error ? err.message : "The release guard refused this config");
    process.exitCode = 1;
  }
}
