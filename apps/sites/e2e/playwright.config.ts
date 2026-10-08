import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { LIFECYCLE_PROJECTS, LIFECYCLE_TITLE } from "./lifecycle.ts";

// Browser tests for the public Worker exactly as `pnpm dev` runs it: wrangler dev over https on
// port 8789, with its own local state (.wrangler/e2e-state, wiped at start). Playwright starts the
// web server before globalSetup, so global-setup.ts seeds the sites into the running server's state.
const REPO = resolve(import.meta.dirname, "../../..");

// Each project posts as its own visitor network (A15 limits each network to 3 stored leads a UTC day per
// site and 5 across all sites). Local wrangler keeps a CF-Connecting-IP the browser sends and sets it from
// the socket only when it is missing, so without this every project would count as the same loopback
// visitor. A project posts one lead per design, each from its own network (sites.spec.ts, designVisitor), so
// every network stores one lead per run, and up to 3 attempts of it (a retry or --repeat-each) fit.
const visitor = (ip: string) => ({ extraHTTPHeaders: { "cf-connecting-ip": ip } });

// The lifecycle tests (sites.spec.ts) change the running server's state through operate.ts, a second workerd process on
// the same local state. While wrangler dev serves another test, that fails at random: miniflare's D1 runs the SQL, then
// getCurrentBookmark() throws "internal error" (miniflare database.worker.js), so a retry could apply a write twice
// (decided 2026-10-08). So they run alone, after every other test: the three main projects leave them out
// (grepInvert) and hand over to lifecycle-chromium as their teardown, which hands over to lifecycle-webkit; each runs
// one test at a time (workers 1). A teardown runs "after this and all dependent projects have finished"
// (playwright.dev/docs/api/class-testproject#test-project-teardown) and, in Playwright 1.63.0, also when a main test
// failed (only `dependencies` skip on failure). It is not narrowed by -g: a design gate (-g <design>) runs all 12
// lifecycle tests, about a minute more. `dependencies` would have run the main projects unfiltered by -g instead.
const LIFECYCLE = new RegExp(LIFECYCLE_TITLE);
const main = { grepInvert: LIFECYCLE, teardown: LIFECYCLE_PROJECTS.chromium };
const lifecycle = { grep: LIFECYCLE, fullyParallel: false, workers: 1 };

export default defineConfig({
  testDir: ".",
  testIgnore: "smoke.spec.ts", // the deployed-page check has its own config (smoke.config.ts)
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  reporter: "list",
  globalSetup: "./global-setup.ts",
  use: { ignoreHTTPSErrors: true },
  webServer: {
    command: "rm -rf .wrangler/e2e-state && node scripts/dev.ts --only sites --persist-to .wrangler/e2e-state",
    cwd: REPO,
    url: "https://localhost:8789/",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
    // Without this Playwright SIGKILLs the process group, which gives dev.ts no chance to stop wrangler.
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    stdout: "ignore",
    stderr: "pipe",
  },
  projects: [
    { name: "chromium-390", ...main, use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, ...visitor("192.0.2.101") } },
    { name: "chromium-1280", ...main, use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, ...visitor("192.0.2.102") } },
    { name: "webkit-390", ...main, use: { ...devices["Desktop Safari"], viewport: { width: 390, height: 844 }, ...visitor("192.0.2.103") } },
    { name: LIFECYCLE_PROJECTS.chromium, ...lifecycle, teardown: LIFECYCLE_PROJECTS.webkit, use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
    { name: LIFECYCLE_PROJECTS.webkit, ...lifecycle, use: { ...devices["Desktop Safari"], viewport: { width: 390, height: 844 } } },
  ],
});
