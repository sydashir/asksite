import { defineConfig, devices } from "@playwright/test";

// The admin app against its Worker with test fakes (test/e2e/wrangler.e2e.jsonc), served over
// https by `vite preview`. Each run starts from an empty local database.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  workers: 2,
  forbidOnly: !!process.env["CI"],
  reporter: "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { baseURL: "https://admin.localhost:8788", ignoreHTTPSErrors: true },
  projects: [
    { name: "chromium-390", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } } },
    { name: "chromium-1280", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
    { name: "webkit-390", use: { ...devices["Desktop Safari"], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    // build:css first: the e2e Worker bundles the owner app's fakes.ts, which imports the generated site stylesheet.
    command:
      "pnpm -w run build:css && rm -rf .wrangler/e2e-state && pnpm build:e2e && pnpm exec wrangler d1 migrations apply asksite --local -c test/e2e/wrangler.e2e.jsonc --persist-to .wrangler/e2e-state && pnpm exec vite preview --mode e2e",
    url: "https://admin.localhost:8788/",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
