import { COPY_LIMITS, prose } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { wordingLength } from "../../src/client/lib/wording-length.ts";

describe("wordingLength", () => {
  // The server (site-schema prose) applies NFKC before it counts: "…" (what iOS types for three dots) becomes "..." and counts 3.
  it("counts 79 letters and an ellipsis as 82, over the headline's 80, exactly as the server does", () => {
    const headline = `${"a".repeat(79)}…`;
    expect(wordingLength(headline)).toBe(82);
    expect(wordingLength(headline)).toBeGreaterThan(COPY_LIMITS.heroHeadline);
    expect(prose(COPY_LIMITS.heroHeadline).safeParse(headline).success).toBe(false);
  });

  it("agrees with the server at the boundary: 77 letters and an ellipsis is exactly 80 and accepted", () => {
    const headline = `${"a".repeat(77)}…`;
    expect(wordingLength(headline)).toBe(COPY_LIMITS.heroHeadline);
    expect(prose(COPY_LIMITS.heroHeadline).safeParse(headline).success).toBe(true);
  });

  it("trims after NFKC and counts a character outside the BMP once", () => {
    expect(wordingLength("  ab  ")).toBe(2);
    expect(wordingLength("a😀")).toBe(2);
  });
});
