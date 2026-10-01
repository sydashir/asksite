import { defineConfig, devices } from "@playwright/test";

// The owner app against its Worker with test fakes (test/e2e/wrangler.e2e.jsonc), served over
// https by `vite preview`. Each run starts from an empty local database (the web server command
// deletes .wrangler/e2e-state first), so every run counts its sign-in emails from zero (M6).
//
// Phones (P4-5, a9-lessons item 3): Playwright's iPhone 13 (WebKit) and Pixel 7 (Chromium) run only
// the tests tagged @mobile (overflow, reflow, axe and tap-target checks).
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  workers: 2,
  forbidOnly: !!process.env["CI"],
  reporter: "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { baseURL: "https://app.localhost:8787", ignoreHTTPSErrors: true },
  projects: [
    { name: "chromium-390", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } },
    { name: "chromium-1280", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
    { name: "webkit-390", use: { ...devices["Desktop Safari"], viewport: { width: 390, height: 844 } } },
    { name: "webkit-iphone", use: { ...devices["iPhone 13"] }, grep: /@mobile/, metadata: { phone: true } },
    { name: "chromium-pixel", use: { ...devices["Pixel 7"] }, grep: /@mobile/, metadata: { phone: true } },
    // Local-only engine check (CI installs chromium and webkit only): run `--project=firefox` before launch.
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, grep: /@firefox/ },
  ],
  webServer: {
    // build:css first: the e2e Worker bundles fakes.ts, which imports the generated site stylesheet.
    command:
      "pnpm -w run build:css && rm -rf .wrangler/e2e-state && pnpm build:e2e && pnpm exec wrangler d1 migrations apply asksite --local -c test/e2e/wrangler.e2e.jsonc --persist-to .wrangler/e2e-state && pnpm exec vite preview --mode e2e",
    url: "https://app.localhost:8787/",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
