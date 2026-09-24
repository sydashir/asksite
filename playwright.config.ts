import { defineConfig, devices } from "@playwright/test";

// Phone, laptop and large desktop in Chromium, plus the phone width in WebKit (Safari's engine;
// iOS is most US mobile traffic). Screenshot baselines are per project and per OS.
const CHROMIUM_WIDTHS = [390, 1200, 1920] as const;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  reporter: "list",
  expect: { toHaveScreenshot: { animations: "disabled" } },
  projects: [
    ...CHROMIUM_WIDTHS.map((width) => ({
      name: `chromium-${width}`,
      use: { ...devices["Desktop Chrome"], viewport: { width, height: 900 } },
    })),
    { name: "webkit-390", use: { ...devices["Desktop Safari"], viewport: { width: 390, height: 844 } } },
  ],
});
