import { PALETTE_IDS } from "@asksite/site-schema";
import { BOLD_COLORS } from "../../../src/designs/impact/tokens.ts";
import { PALETTES, type Palette } from "../../../src/theme.ts";
import type { Pair } from "../baseline-pairs.ts";

const WHITE = "#FFFFFF";

/** The palette id of a PALETTES entry (the contrast test passes the entries themselves). */
function paletteId(p: Palette) {
  const id = PALETTE_IDS.find((candidate) => PALETTES[candidate] === p);
  if (id === undefined) throw new Error("Bold's pairs need one of the PALETTES entries");
  return id;
}

/**
 * Every text-on-background pair the Bold templates use (A12): heading, body and muted text on the three light
 * surfaces (the page, the tint and white cards), the three ink text colours on the three ink surfaces (the bands,
 * raised cards and chips, and the footer), and the label on the action colour at rest and on hover. A ghost button
 * on hover swaps its text and surface, which is the same pair.
 */
export function pairs(p: Palette): Pair[] {
  const c = BOLD_COLORS[paletteId(p)];
  const light: Array<[string, string]> = [
    ["page", p.bgPage],
    ["tint", c.tint],
    ["white card", WHITE],
  ];
  const dark: Array<[string, string]> = [
    ["ink band", c.ink],
    ["raised ink", c.inkRaised],
    ["deep ink footer", c.inkDeep],
  ];
  return [
    ...light.flatMap(([name, bg]): Pair[] => [
      [`heading on ${name}`, p.textHeading, bg],
      [`body text on ${name}`, p.textDefault, bg],
      [`muted text on ${name}`, p.textMuted, bg],
    ]),
    ...dark.flatMap(([name, bg]): Pair[] => [
      [`white on ${name}`, WHITE, bg],
      [`soft text on ${name}`, c.onInkSoft, bg],
      [`muted text on ${name}`, c.onInkMuted, bg],
    ]),
    ["label on the action colour", c.onAccent, c.accent],
    ["label on the action colour (hover)", c.onAccent, c.accentHover],
  ];
}
