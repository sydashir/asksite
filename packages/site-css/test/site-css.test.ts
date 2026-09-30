import { sha256Hex } from "@asksite/core";
import { describe, expect, it } from "vitest";
import { SITE_CSS, SITE_CSS_SHA256 } from "../src/index.ts";

// SITE_CSS is the deprecated alias of the impact sheet (A12 addendum H2). design-css.test.ts pins it to
// DESIGN_CSS.impact and each design's sheet to its compiled file, so no check here names a sheet file.
describe("@asksite/site-css", () => {
  it("is a compiled Tailwind stylesheet", () => {
    expect(SITE_CSS).toContain("tailwindcss v4.3.3");
  });

  it("carries the SHA-256 that core's sha256Hex computes", async () => {
    expect(SITE_CSS_SHA256).toBe(await sha256Hex(SITE_CSS));
    expect(SITE_CSS_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("can be inlined: render() refuses a stylesheet containing </style", () => {
    expect(SITE_CSS).not.toMatch(/<\/style/i);
  });
});
