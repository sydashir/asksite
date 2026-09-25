import { defineConfig } from "vitest/config";

// Worker tests start the real Worker in the local runtime (createTestHarness), so they get
// longer timeouts than pure unit tests.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
