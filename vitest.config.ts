import { configDefaults, defineConfig } from "vitest/config";

// Two projects that `pnpm test` runs one after the other. "unit": pure tests (all of Plan 1's).
// "workerd": tests that start workerd through wrangler's test harness (*.workerd.test.ts), kept apart
// so workerd never competes for CPU with Plan 1's timing-sensitive property tests. The globs cover
// every package and every apps/<worker>, so later plans add tests without editing this file.
// A third project, "browser" (*.browser.test.ts), holds tests that launch Chromium or WebKit from vitest
// (Playwright's browsers). `pnpm test` never runs it: CI's check job has no browsers, so `pnpm test:browser`
// runs it in the sites job, inside the Playwright container. Locally a browser run is HEAVY (run.sh).
// The globs of the three projects exclude each other, so no file runs in two projects.
const WORKERD = ["packages/*/test/**/*.workerd.test.ts", "apps/*/test/**/*.workerd.test.ts"];
const BROWSER = ["packages/*/test/**/*.browser.test.ts", "apps/*/test/**/*.browser.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...WORKERD, ...BROWSER],
          // Plan 1's seeded property test takes about 0.8 s alone but passed Vitest's 5 s default on a
          // heavily loaded machine (Decision 23). A hanging test still fails, after 30 s.
          testTimeout: 30_000,
        },
      },
      {
        test: { name: "workerd", include: WORKERD, exclude: [...configDefaults.exclude, ...BROWSER], testTimeout: 30_000, hookTimeout: 120_000 },
      },
      {
        // Launching a browser happens in a hook, so the hook timeout is workerd's.
        test: { name: "browser", include: BROWSER, exclude: [...configDefaults.exclude, ...WORKERD], testTimeout: 30_000, hookTimeout: 120_000 },
      },
    ],
  },
});
