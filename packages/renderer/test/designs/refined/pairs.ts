// Classic (refined): every text-on-background pair its templates use, in the page's palette. The shared
// contrast test (test/theme.test.ts) holds each one to WCAG AA 4.5:1. Non-text pairs (focus rings, field
// borders, decorative rules) have their own minimums in classic.test.ts.
import { PALETTE_IDS } from "@asksite/site-schema";
import { PALETTES as CLASSIC, type ClassicPalette } from "../../../src/designs/refined/tokens.ts";
import { PALETTES, type Palette } from "../../../src/theme.ts";
import type { Pair } from "../baseline-pairs.ts";

/** Classic's colours for the shared palette `p` (one of the four presets). */
export function classicPalette(p: Palette): ClassicPalette {
  const id = PALETTE_IDS.find((each) => PALETTES[each] === p);
  if (id === undefined) throw new Error("Not one of the four palette presets");
  return CLASSIC[id];
}

export function pairs(p: Palette): Pair[] {
  const c = classicPalette(p);
  const light = (["paper", "surface"] as const).flatMap((bg): Pair[] =>
    (["ink", "text", "muted", "brand", "accentText"] as const).map((fg): Pair => [`${fg} on ${bg}`, c[fg], c[bg]]),
  );
  const dark = (["dark", "dark2"] as const).flatMap((bg): Pair[] =>
    (["onDark", "onDarkMuted", "accentOnDark"] as const).map((fg): Pair => [`${fg} on ${bg}`, c[fg], c[bg]]),
  );
  return [
    ...light,
    ...dark,
    ["Call and Send labels (onAction on action)", c.onAction, c.action],
    ["Call and Send labels on hover (onAction on actionHover)", c.onAction, c.actionHover],
    ["quote button label on hover (surface on brand)", c.surface, c.brand],
    // The shared skip link (render.ts) keeps the shared palette's colours.
    ["skip link (shared textHeading on bgPage)", p.textHeading, p.bgPage],
  ];
}
