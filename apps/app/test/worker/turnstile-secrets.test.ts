import { describe, expect, it } from "vitest";
import { isDocumentedTestSecret } from "../../src/worker/turnstile-secrets.ts";
import { TURNSTILE_LIVE_SECRET, TURNSTILE_NEAR_MISS_SECRET, TURNSTILE_TEST_SECRET } from "../support/turnstile.ts";

// developers.cloudflare.com/turnstile/troubleshooting/testing/ lists exactly three dummy secret keys.
describe("documented Turnstile test secrets", () => {
  it("recognizes exactly the three documented dummy secrets", () => {
    for (const secret of [TURNSTILE_TEST_SECRET, "2x0000000000000000000000000000000AA", "3x0000000000000000000000000000000AA"]) {
      expect(isDocumentedTestSecret(secret)).toBe(true);
    }
  });

  it("recognizes nothing else: not a near miss, a prefix, a suffix, a production-style key or an empty one", () => {
    for (const secret of [TURNSTILE_NEAR_MISS_SECRET, TURNSTILE_LIVE_SECRET, "", `${TURNSTILE_TEST_SECRET} `, TURNSTILE_TEST_SECRET.slice(1), `x${TURNSTILE_TEST_SECRET}`]) {
      expect(isDocumentedTestSecret(secret)).toBe(false);
    }
  });
});
