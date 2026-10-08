import { MAX_ISSUES } from "@asksite/app-common";
import { describe, expect, it } from "vitest";
import { publishRefusal } from "../../src/worker/publish-refusal.ts";

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);

describe("publishRefusal", () => {
  it("answers each refusal the owner can act on", () => {
    expect(publishRefusal("site_taken_down", undefined, NOW)).toMatchObject({ code: "site_taken_down" });
    expect(publishRefusal("publish_cap_reached", { retryAfter: 120 }, NOW)).toMatchObject({ code: "rate_limited", extra: { retryAfter: 120 } });
    expect(publishRefusal("publish_cap_reached", undefined, NOW)).toMatchObject({ code: "rate_limited", extra: { retryAfter: 43_200 } });
    expect(publishRefusal("integrity", { reason: "site_changed" }, NOW)).toMatchObject({ code: "conflict" });
  });

  it("lists the page's problems when it cannot be rendered", () => {
    const issues = [{ path: ["copy", "heroHeadline"], code: "custom", message: "Copy must not contain numbers" }];
    expect(publishRefusal("render_failed", issues, NOW)).toMatchObject({ code: "publish_invalid", extra: { issues } });
    expect(publishRefusal("render_failed", "garbled", NOW)?.extra.issues).toEqual([{ path: [], code: "render_failed", message: "The page could not be built" }]);
  });

  it(`lists at most the first MAX_ISSUES (${MAX_ISSUES}) of the page's problems, in order (P4-3)`, () => {
    const issues = Array.from({ length: MAX_ISSUES + 10 }, (_, i) => ({ path: ["facts", "photos", i, "alt"], code: "too_small", message: "Describe this photo" }));
    expect(publishRefusal("render_failed", issues, NOW)?.extra.issues).toEqual(issues.slice(0, MAX_ISSUES));
  });

  it("leaves everything else to the shared handler (500, no details)", () => {
    expect(publishRefusal("integrity", { reason: "hash_mismatch" }, NOW)).toBeNull();
    expect(publishRefusal("nothing_pending", undefined, NOW)).toBeNull();
  });
});
