import { configDefaults, defineConfig } from "vitest/config";

// Two projects that `pnpm test` runs one after the other. "unit": pure tests (all of Plan 1's).
// "workerd": tests that start workerd through wrangler's test harness (*.workerd.test.ts), kept apart
// so workerd never competes for CPU with Plan 1's timing-sensitive property tests. The globs cover
// every package and every apps/<worker>, so later plans add tests without editing this file.
const WORKERD = ["packages/*/test/**/*.workerd.test.ts", "apps/*/test/**/*.workerd.test.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...WORKERD],
          // Plan 1's seeded property test takes about 0.8 s alone but passed Vitest's 5 s default on a
          // heavily loaded machine (Decision 23). A hanging test still fails, after 30 s.
          testTimeout: 30_000,
        },
      },
      {
        test: { name: "workerd", include: WORKERD, testTimeout: 30_000, hookTimeout: 120_000 },
      },
    ],
  },
});
