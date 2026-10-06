// The Bold design's own colours per palette (A12: design constants, named --aw-impact-*). Heading, text,
// muted and page colours are the palette's own (src/theme.ts); these add the action colour, the ink
// surfaces and the hairlines the design needs. Values are the approved mockup's (bold-v2 round 4,
// _work/tokens.json); test/designs/impact/pairs.ts checks every text pair against WCAG AA.
import type { PaletteId, Theme } from "@asksite/site-schema";

export interface BoldColors {
  /** The one action colour, used only on things you can tap. */
  readonly accent: string;
  readonly onAccent: string;
  readonly accentHover: string;
  /** The edge a light action colour needs on light surfaces ("transparent" when the fill is dark enough). */
  readonly keyline: string;
  /** The dark bands: the hero, the header, the contact band and the call bar. */
  readonly ink: string;
  readonly inkRaised: string;
  readonly inkDeep: string;
  readonly inkLine: string;
  readonly onInkSoft: string;
  readonly onInkMuted: string;
  /** The second light surface, and the hairline and field-border colours on light surfaces. */
  readonly tint: string;
  readonly line: string;
  readonly field: string;
}

export const BOLD_COLORS: Readonly<Record<PaletteId, BoldColors>> = {
  "navy-orange": {
    accent: "#EA580C",
    onAccent: "#0B1220",
    accentHover: "#F97316",
    keyline: "transparent",
    ink: "#0B1F3A",
    inkRaised: "#132C4F",
    inkDeep: "#071528",
    inkLine: "#243C5E",
    onInkSoft: "#D6DEEA",
    onInkMuted: "#A8B7CB",
    tint: "#F1F4F8",
    line: "#D5DCE5",
    field: "#6B7686",
  },
  "blue-yellow": {
    accent: "#FACC15",
    onAccent: "#0A1628",
    accentHover: "#FDE047",
    keyline: "#0A1628",
    ink: "#0C3563",
    inkRaised: "#144174",
    inkDeep: "#082A50",
    inkLine: "#2B5485",
    onInkSoft: "#D5DFE9",
    onInkMuted: "#A6B7C9",
    tint: "#F0F4F8",
    line: "#D4DDE6",
    field: "#687888",
  },
  "green-amber": {
    accent: "#D97706",
    onAccent: "#0C1A12",
    accentHover: "#F59E0B",
    keyline: "transparent",
    ink: "#0F2A1D",
    inkRaised: "#173A29",
    inkDeep: "#0A1F15",
    inkLine: "#284A39",
    onInkSoft: "#D8E4DC",
    onInkMuted: "#A9BDB0",
    tint: "#F1F3EC",
    line: "#D6DBD0",
    field: "#6C7A70",
  },
  "charcoal-red": {
    accent: "#DC2626",
    onAccent: "#FFFFFF",
    accentHover: "#B91C1C",
    keyline: "transparent",
    ink: "#1C1C1E",
    inkRaised: "#29292C",
    inkDeep: "#121213",
    inkLine: "#3A3A3E",
    onInkSoft: "#DCDCDE",
    onInkMuted: "#ABABB1",
    tint: "#F4F3F1",
    line: "#DDDBD7",
    field: "#707070",
  },
};

/** The page's --aw-impact-* custom properties for its palette. */
export function boldVariables(theme: Theme): Record<string, string> {
  const c = BOLD_COLORS[theme.palette];
  return {
    "--aw-impact-accent": c.accent,
    "--aw-impact-on-accent": c.onAccent,
    "--aw-impact-accent-hover": c.accentHover,
    "--aw-impact-keyline": c.keyline,
    "--aw-impact-ink": c.ink,
    "--aw-impact-ink-raised": c.inkRaised,
    "--aw-impact-ink-deep": c.inkDeep,
    "--aw-impact-ink-line": c.inkLine,
    "--aw-impact-on-ink-soft": c.onInkSoft,
    "--aw-impact-on-ink-muted": c.onInkMuted,
    "--aw-impact-tint": c.tint,
    "--aw-impact-line": c.line,
    "--aw-impact-field": c.field,
  };
}
