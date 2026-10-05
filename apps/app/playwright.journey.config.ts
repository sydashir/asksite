import { defineConfig, devices } from "@playwright/test";

// The whole product on this machine: the sites, app, admin and generator Workers in one local
// runtime (e2e-journey/server.ts), over https on port 8789, with the log mailer and the fake model
// provider. Every run starts from an empty database and uses new emails and slugs.
export default defineConfig({
  testDir: "e2e-journey",
  testMatch: "*.spec.ts",
  reporter: "list",
  timeout: 240_000,
  // One at a time: the kill-switch test switches the AI off for every owner while it runs.
  workers: 1,
  use: { ignoreHTTPSErrors: true, trace: "retain-on-failure" },
  projects: [
    { name: "chromium-1280", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
    { name: "webkit-390", use: { ...devices["Desktop Safari"], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    // First the refusals and the port check (fast, before any build), then the app is built for this
    // machine (ROOT_DOMAIN localhost:8789) and the server starts.
    command: "node e2e-journey/server.ts --check && pnpm -w run build:css && pnpm run build && node e2e-journey/server.ts",
    url: "https://app.localhost:8789/",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 300_000,
    // SIGTERM lets the server close its runtime; Playwright's default SIGKILL would not.
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
