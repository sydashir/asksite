// Modern (modern): every text-on-background pair its templates use, in Modern's own colours for the owner's
// palette (src/designs/modern/tokens.ts). test/theme.test.ts checks each for WCAG AA (4.5:1); the non-text pairs
// (icons, field borders, focus rings, 3:1) are checked in test/designs/modern/modern.test.ts.
import { PALETTE_IDS, type PaletteId } from "@asksite/site-schema";
import { MODERN_COLORS, type ModernColors } from "../../../src/designs/modern/tokens.ts";
import { PALETTES, type Palette } from "../../../src/theme.ts";
import type { Pair } from "../baseline-pairs.ts";

const WHITE = "#FFFFFF";

/** The palette id whose preset `palette` is (the tests pass PALETTES[id] itself). */
export function paletteIdOf(palette: Palette): PaletteId {
  const id = PALETTE_IDS.find((candidate) => PALETTES[candidate] === palette);
  if (id === undefined) throw new Error("Not one of the palette presets");
  return id;
}

/** The text pairs, each as [label, foreground, background]. */
export function modernTextPairs(c: ModernColors): Pair[] {
  return [
    ["headings on white", c.ink, WHITE],
    ["body text on white", c.text, WHITE],
    ["secondary text on white", c.muted, WHITE],
    ["brand links on white (the more-licenses link)", c.brand, WHITE],
    ["headings on the tint", c.ink, c.tint],
    ["body text on the tint", c.text, c.tint],
    ["secondary text on the tint (prices, captions, cards)", c.muted, c.tint],
    ["action button text", c.onAct, c.act],
    ["action button text, hover", c.onAct, c.actHover],
    ["white on the brand band", WHITE, c.brand],
    ["secondary text on the brand band", c.onBrandMuted, c.brand],
    ["action button text on the brand band", c.onBandAct, c.bandAct],
    ["action button text on the brand band, hover", c.onBandAct, c.bandActHover],
    ["outline button on the brand band, hover", c.brand, WHITE],
    ["outline button, hover", WHITE, c.ink],
    ["the Emergencies note", c.ink, c.well],
  ];
}

export function pairs(palette: Palette): Pair[] {
  // The shared skip link (render.ts) keeps the theme's own colours.
  return [...modernTextPairs(MODERN_COLORS[paletteIdOf(palette)]), ["the skip link", palette.textHeading, palette.bgPage]];
}
