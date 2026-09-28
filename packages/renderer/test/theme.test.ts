import { DESIGN_IDS, FONT_IDS, PALETTE_IDS } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { AA_NORMAL_TEXT, contrastRatio, hexToRgb } from "../src/contrast.ts";
import { FONTS, PALETTES, themeStyle, themeVariables } from "../src/theme.ts";
import { pairs } from "./designs/baseline-pairs.ts";
import { DESIGN_PAIRS } from "./designs/index.ts";

const WHITE = "#FFFFFF";

describe("palette presets", () => {
  it("covers every palette id in the schema", () => {
    expect(Object.keys(PALETTES).sort()).toEqual([...PALETTE_IDS].sort());
  });

  // Every design with every palette, from that design's own pairs (A12).
  describe.each(DESIGN_IDS)("in the %s design", (design) => {
    describe.each(PALETTE_IDS)("%s", (id) => {
      it.each(DESIGN_PAIRS[design](PALETTES[id]))("%s passes AA (4.5:1)", (_label, fg, bg) => {
        expect(contrastRatio(hexToRgb(fg), hexToRgb(bg))).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    });
  });

  it("the check catches a failing pair (RED proof)", () => {
    const failing = { ...PALETTES["navy-orange"], textMuted: "#9CA3AF" };
    const muted = pairs(failing).find(([label]) => label === "textMuted on page");
    expect(muted).toBeDefined();
    const [, fg, bg] = muted ?? ["", WHITE, WHITE];
    expect(contrastRatio(hexToRgb(fg), hexToRgb(bg))).toBeLessThan(AA_NORMAL_TEXT);
  });
});

describe("font presets", () => {
  it("covers every font id in the schema", () => {
    expect(Object.keys(FONTS).sort()).toEqual([...FONT_IDS].sort());
  });
  it("uses system stacks only (no web-font URLs)", () => {
    for (const preset of Object.values(FONTS)) {
      expect(JSON.stringify(preset)).not.toMatch(/url\(|https?:|@import/);
      expect(preset.heading).toMatch(/sans-serif$/);
    }
  });
});

describe("theme output", () => {
  it("resolves to exactly 12 CSS custom properties", () => {
    const vars = themeVariables({ palette: "navy-orange", font: "clean" });
    expect(Object.keys(vars)).toHaveLength(12);
    expect(vars["--aw-color-primary"]).toBe("#1D4ED8");
    expect(vars["--aw-font-sans"]).toBe("system-ui, sans-serif");
  });
  it("renders one inline :root style block", () => {
    const css = String(themeStyle({ palette: "charcoal-red", font: "sturdy" }));
    expect(css.startsWith("<style>:root{--aw-font-sans:system-ui, sans-serif;")).toBe(true);
    expect(css).toContain("--aw-color-primary:#B91C1C;");
    expect(css.endsWith("}</style>")).toBe(true);
  });
  it("appends a design's own properties inside the same :root rule (A12)", () => {
    const theme = { palette: "charcoal-red", font: "sturdy" } as const;
    const css = String(themeStyle(theme, { "--aw-impact-accent": "#000000" }));
    expect(css.match(/:root\{/g)).toHaveLength(1);
    expect(css.endsWith("--aw-color-link:#B91C1C;--aw-impact-accent:#000000;}</style>")).toBe(true);
    expect(String(themeStyle(theme, {}))).toBe(String(themeStyle(theme)));
  });
});
