import { defineConfig, devices } from "@playwright/test";

// Phone, laptop and large desktop in Chromium, plus the phone width in WebKit (Safari's engine;
// iOS is most US mobile traffic). Screenshot baselines are per project and per OS. These four are
// desktop browsers at a narrow window: they ignore the page's meta viewport and report a mouse.
const CHROMIUM_WIDTHS = [390, 1200, 1920] as const;

// Real phone emulation (A9): Playwright's iPhone 13 (WebKit) and Pixel 7 (Chromium) descriptors apply
// the page's meta viewport, a touch screen and the device pixel ratio. They run only the tests tagged
// @mobile (the layout, reflow and axe checks), so they have no screenshot baselines, and keyboard-focus
// tests stay on the desktop projects. metadata.phone marks them for the test that proves they are phones.
const PHONES = [
  { name: "webkit-iphone", device: "iPhone 13" },
  { name: "chromium-pixel", device: "Pixel 7" },
] as const;

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
    ...PHONES.map(({ name, device }) => ({ name, use: { ...devices[device] }, grep: /@mobile/, metadata: { phone: true } })),
  ],
});
