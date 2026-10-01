import { defineConfig, devices } from "@playwright/test";

// One real-browser check of a deployed page (Task 19 Step 11): no web server, one Chromium project.
// Usage: ASKSITE_SMOKE_URL=https://smoke-test.<domain>/ pnpm exec playwright test -c apps/sites/e2e/smoke.config.ts
// Certificate errors are ignored only for a local *.localhost rehearsal; a real domain must have valid TLS.
const url = process.env["ASKSITE_SMOKE_URL"] ?? "";

export default defineConfig({
  testDir: ".",
  testMatch: "smoke.spec.ts",
  reporter: "list",
  use: { ignoreHTTPSErrors: url !== "" && new URL(url).hostname.endsWith(".localhost") },
  projects: [{ name: "chromium-390", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } }],
});
