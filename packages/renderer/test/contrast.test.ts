import { describe, expect, it } from "vitest";
import { contrastRatio, hexToRgb, relativeLuminance } from "../src/contrast.ts";

describe("hexToRgb", () => {
  it("parses #RRGGBB in either case", () => {
    expect(hexToRgb("#1d4ED8")).toEqual([29, 78, 216]);
  });
  it("rejects anything else", () => {
    expect(() => hexToRgb("#fff")).toThrow("Expected #RRGGBB");
    expect(() => hexToRgb("rgb(0 0 0)")).toThrow("Expected #RRGGBB");
  });
});

describe("WCAG 2.2 contrast", () => {
  it("luminance endpoints are 0 and 1", () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 10);
  });
  it("black on white is 21:1 in either order", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 10);
    expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 10);
  });
  it("a colour on itself is 1:1", () => {
    expect(contrastRatio([10, 20, 30], [10, 20, 30])).toBe(1);
  });
  it("#767676 on white passes AA at 4.54:1 and #777777 fails at 4.48:1", () => {
    expect(contrastRatio(hexToRgb("#767676"), hexToRgb("#FFFFFF"))).toBeCloseTo(4.54, 2);
    expect(contrastRatio(hexToRgb("#777777"), hexToRgb("#FFFFFF"))).toBeCloseTo(4.48, 2);
  });
});
