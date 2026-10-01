import { describe, expect, it } from "vitest";
import { TAKEDOWN_REVIEW_NOTE } from "../src/index.ts";

describe("TAKEDOWN_REVIEW_NOTE", () => {
  // Stored site_versions rows hold these bytes, and the owner app compares with them: they never change.
  it("is the note takeDown has always written", () => {
    expect(TAKEDOWN_REVIEW_NOTE).toBe("Site taken down");
  });
});
