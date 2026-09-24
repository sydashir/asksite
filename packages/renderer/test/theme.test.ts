import { FONT_IDS, PALETTE_IDS } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { AA_NORMAL_TEXT, contrastRatio, hexToRgb } from "../src/contrast.ts";
import { FONTS, PALETTES, themeStyle, themeVariables, type Palette } from "../src/theme.ts";

const WHITE = "#FFFFFF";

// Every text-on-background pair the section templates use. Adding a new pairing to a
// template means adding it here first.
function pairs(p: Palette): Array<[label: string, fg: string, bg: string]> {
  const onSurfaces = (["textHeading", "textDefault", "textMuted", "primary", "secondary", "link"] as const).flatMap(
    (key): Array<[string, string, string]> => [
      [`${key} on page`, p[key], p.bgPage],
      [`${key} on white card`, p[key], WHITE],
    ],
  );
  return [
    ...onSurfaces,
    ["white on primary button", WHITE, p.primary],
    ["white on secondary (button hover)", WHITE, p.secondary],
    ["white on dark band", WHITE, p.bgPageDark],
    ["heading text on accent badge", p.textHeading, p.accent],
  ];
}

describe("palette presets", () => {
  it("covers every palette id in the schema", () => {
    expect(Object.keys(PALETTES).sort()).toEqual([...PALETTE_IDS].sort());
  });

  describe.each(PALETTE_IDS)("%s", (id) => {
    it.each(pairs(PALETTES[id]))("%s passes AA (4.5:1)", (_label, fg, bg) => {
      expect(contrastRatio(hexToRgb(fg), hexToRgb(bg))).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
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
});
