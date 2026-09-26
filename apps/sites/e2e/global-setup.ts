import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Publishes and approves every Plan 1 fixture into the running server's local state through the real
// publishing functions (apps/sites/dev/seed.ts), with photos served from media.localhost:8789.
export const E2E_FIXTURES = ["plumber-austin", "hvac-phoenix", "roofing-extreme", "cleaning-minimal", "electrical-xss"] as const;
const REPO = resolve(import.meta.dirname, "../../..");

export default function globalSetup(): void {
  const seeded: Record<string, { siteId: string; url: string }> = {};
  for (const fixture of E2E_FIXTURES) {
    const out = execFileSync("node", ["apps/sites/dev/seed.ts", "--slug", `e2e-${fixture}`, "--fixture", fixture, "--persist-to", ".wrangler/e2e-state"], {
      cwd: REPO,
      encoding: "utf8",
    });
    const line = out.trim().split("\n").at(-1) ?? "";
    seeded[fixture] = JSON.parse(line) as { siteId: string; url: string };
  }
  process.env["ASKSITE_E2E_SITES"] = JSON.stringify(seeded);
}
