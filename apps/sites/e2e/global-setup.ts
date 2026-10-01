import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { DESIGN_IDS, type DesignId } from "@asksite/site-schema";
import { LIFECYCLE_ENGINES, lifecycleSlug } from "./lifecycle.ts";

// Publishes and approves every Plan 1 fixture in every page design (A12) into the running server's local
// state through the real publishing functions (apps/sites/dev/seed.ts), with photos served from
// media.localhost:8789.
export const E2E_FIXTURES = ["plumber-austin", "hvac-phoenix", "roofing-extreme", "cleaning-minimal", "electrical-xss"] as const;
export type E2eFixture = (typeof E2E_FIXTURES)[number];

/** The slug of a fixture's site in a design; the longest, e2e-refined-cleaning-minimal, has 28 of a slug's 40 characters. */
export const e2eSlug = (design: DesignId, fixture: E2eFixture): string => `e2e-${design}-${fixture}`;

const REPO = resolve(import.meta.dirname, "../../..");

export default function globalSetup(): void {
  const seeded: Record<string, { siteId: string; url: string }> = {};
  for (const design of DESIGN_IDS) {
    for (const fixture of E2E_FIXTURES) {
      const slug = e2eSlug(design, fixture);
      const args = ["apps/sites/dev/seed.ts", "--slug", slug, "--fixture", fixture, "--design", design, "--persist-to", ".wrangler/e2e-state"];
      const out = execFileSync("node", args, { cwd: REPO, encoding: "utf8" });
      const line = out.trim().split("\n").at(-1) ?? "";
      seeded[slug] = JSON.parse(line) as { siteId: string; url: string };
    }
  }
  // The sites the lifecycle tests change (approve a second version, take down, restore), one per design and engine,
  // so no other test ever sees them change; seeded in one call (operate.ts) to start wrangler's bindings once.
  const lifecycle = DESIGN_IDS.flatMap((design) => LIFECYCLE_ENGINES.map((engine) => `${lifecycleSlug(design, engine)}:plumber-austin:${design}`));
  execFileSync("node", ["apps/sites/e2e/operate.ts", "seed", ...lifecycle], { cwd: REPO, encoding: "utf8" });
  process.env["ASKSITE_E2E_SITES"] = JSON.stringify(seeded);
}
