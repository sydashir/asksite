import { describe, expect, it } from "vitest";
import { publishApiError } from "../../src/worker/publish-errors.ts";

describe("publishApiError", () => {
  it("answers each publishing failure the admin can act on with the design's code", () => {
    expect(publishApiError("site_not_found", "change")).toMatchObject({ code: "not_found" });
    expect(publishApiError("version_not_pending", "review")).toMatchObject({ code: "version_not_pending" });
    expect(publishApiError("site_taken_down", "review")).toMatchObject({ code: "site_taken_down" });
    expect(publishApiError("not_live", "restore")).toMatchObject({ code: "conflict" });
  });

  it("words an integrity failure for the action, and never shows its details", () => {
    expect(publishApiError("integrity", "review")?.message).toBe("The stored page does not match what was reviewed. Reload and review it again.");
    expect(publishApiError("integrity", "restore")?.message).toBe("The stored page does not match its record. It was not restored.");
    expect(publishApiError("integrity", "restore")).toMatchObject({ code: "internal", extra: {} });
  });

  it("leaves owner-side failures to the caller, which answers 500", () => {
    expect(publishApiError("render_failed", "review")).toBeNull();
    expect(publishApiError("publish_cap_reached", "review")).toBeNull();
  });
});
