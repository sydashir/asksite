// Classic's colours and lettering, per palette and font preset (the ids are the shared contract ids).
// Every text/background pair is checked in test/designs/refined/. Zero font bytes: every face is a
// system font (Apple lists Charter, Rockwell and Palatino as system fonts on iOS and macOS; Windows 11
// ships Sitka, Cambria and Palatino Linotype; Android falls back to Noto Serif). A preset also changes
// weight, case, italics, corners and rules, which survive a missing font.
import type { FontId, PaletteId, Theme } from "@asksite/site-schema";

export interface ClassicPalette {
  paper: string;
  surface: string;
  ink: string;
  text: string;
  muted: string;
  brand: string;
  accent: string;
  accentText: string;
  line: string;
  rule: string;
  field: string;
  dark: string;
  dark2: string;
  onDark: string;
  onDarkMuted: string;
  accentOnDark: string;
  action: string;
  actionHover: string;
  onAction: string;
}

// Solid hex only, so contrast can be checked exactly.
export const PALETTES: Readonly<Record<PaletteId, ClassicPalette>> = {
  // Navy & copper
  "navy-orange": {
    paper: "#F6F1E9",
    surface: "#FFFFFF",
    ink: "#14233A",
    text: "#2C3341",
    muted: "#545C6A",
    brand: "#1E3A5F",
    accent: "#B5652F",
    accentText: "#93501F",
    line: "#E6DED2",
    rule: "#B0A28C",
    field: "#7D8491",
    dark: "#172B45",
    dark2: "#10203A",
    onDark: "#F6F1E9",
    onDarkMuted: "#BCC6D3",
    accentOnDark: "#E7A877",
    action: "#C2410C",
    actionHover: "#9A3412",
    onAction: "#FFFFFF",
  },
  // Harbor blue & gold
  "blue-yellow": {
    paper: "#F3F2EC",
    surface: "#FFFFFF",
    ink: "#0F2139",
    text: "#28303D",
    muted: "#515A68",
    brand: "#0F4C81",
    accent: "#C59336",
    accentText: "#94611A",
    line: "#E2E0D6",
    rule: "#ABA999",
    field: "#7B8390",
    dark: "#123C63",
    dark2: "#0C2B49",
    onDark: "#F3F2EC",
    onDarkMuted: "#C3CEDB",
    accentOnDark: "#F2C455",
    action: "#F2B630",
    actionHover: "#E0A112",
    onAction: "#10223A",
  },
  // Forest & brass
  "green-amber": {
    paper: "#F3F1E8",
    surface: "#FFFFFF",
    ink: "#13291F",
    text: "#2A332D",
    muted: "#525E56",
    brand: "#1F4A38",
    accent: "#A87A2A",
    accentText: "#7A5714",
    line: "#E2DECF",
    rule: "#ADA792",
    field: "#7C857F",
    dark: "#173A2C",
    dark2: "#10291F",
    onDark: "#F3F1E8",
    onDarkMuted: "#BCCCC1",
    accentOnDark: "#E3BC6E",
    action: "#E8A03A",
    actionHover: "#D68A1F",
    onAction: "#13291F",
  },
  // Charcoal & brick
  "charcoal-red": {
    paper: "#F4F1EC",
    surface: "#FFFFFF",
    ink: "#1C1D20",
    text: "#2E2F33",
    muted: "#58595E",
    brand: "#33363C",
    accent: "#A6452F",
    accentText: "#9A3C27",
    line: "#E4DFD8",
    rule: "#AFA79D",
    field: "#7F8086",
    dark: "#2B2D31",
    dark2: "#202225",
    onDark: "#F4F1EC",
    onDarkMuted: "#C6C6CB",
    accentOnDark: "#EC9A83",
    action: "#B91C1C",
    actionHover: "#991B1B",
    onAction: "#FFFFFF",
  },
};

export interface ClassicLettering {
  /** Heading serif and body stacks, and each one's font-size-adjust. */
  head: string;
  body: string;
  headAdjust: string;
  bodyAdjust: string;
  headWeight: string;
  titleCase: string;
  titleTrack: string;
  titleScale: string;
  heroScale: string;
  heroTrack: string;
  /** Space between the hero's eyebrow and headline, so the gap you see matches across presets. */
  heroGap: string;
  /** The eyebrow's font shorthand: style, weight, size/line-height and family. */
  eyebrow: string;
  eyebrowCase: string;
  eyebrowTrack: string;
  /** The weight of the big decorative quote marks: a bold Palatino mark reads as two slashes. */
  quoteWeight: string;
  radius: string;
  radiusCard: string;
  radiusPaper: string;
  ruleH: string;
  ruleW: string;
}

const BODY = "var(--aw-refined-body)";
const HEAD = "var(--aw-refined-head)";

export const LETTERING: Readonly<Record<FontId, ClassicLettering>> = {
  // Transitional serif, bold headings in sentence case, small tracked capitals, soft corners.
  clean: {
    head: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, "Noto Serif", serif',
    body: "system-ui, sans-serif",
    headAdjust: "ex-height .48",
    bodyAdjust: "none",
    headWeight: "700",
    titleCase: "none",
    titleTrack: "-.01em",
    titleScale: "1",
    heroScale: "1",
    heroTrack: "-.014em",
    heroGap: ".625rem",
    eyebrow: `650 .8125rem/1.4 ${BODY}`,
    eyebrowCase: "uppercase",
    eyebrowTrack: ".13em",
    quoteWeight: "700",
    radius: ".375rem",
    radiusCard: ".375rem",
    radiusPaper: "0px",
    ruleH: "2px",
    ruleW: "2.5rem",
  },
  // Slab serif (Rockwell on every Apple device), capital section titles, square corners, heavy rules.
  sturdy: {
    head: 'Rockwell, "Rockwell Nova", Cambria, "Noto Serif", serif',
    body: "system-ui, sans-serif",
    headAdjust: "ex-height .51",
    bodyAdjust: "none",
    headWeight: "700",
    titleCase: "uppercase",
    titleTrack: ".035em",
    titleScale: ".8",
    heroScale: ".96",
    heroTrack: "-.006em",
    heroGap: "clamp(.9375rem, .8rem + .55vw, 1.25rem)",
    eyebrow: `800 .8125rem/1.4 ${BODY}`,
    eyebrowCase: "uppercase",
    eyebrowTrack: ".16em",
    quoteWeight: "700",
    radius: "0px",
    radiusCard: "0px",
    radiusPaper: "0px",
    ruleH: "4px",
    ruleW: "3.25rem",
  },
  // Old-style serif at regular weight, slanted serif eyebrows, pill buttons, round-cornered cards.
  friendly: {
    head: '"Palatino Linotype", Palatino, "URW Palladio L", P052, "Noto Serif", serif',
    body: '"Avenir Next", Avenir, Candara, "source-sans-pro", system-ui, sans-serif',
    headAdjust: "ex-height .47",
    bodyAdjust: "ex-height .5",
    headWeight: "400",
    titleCase: "none",
    titleTrack: "-.005em",
    titleScale: "1.08",
    heroScale: "1.06",
    heroTrack: "-.012em",
    heroGap: "clamp(.625rem, .45rem + .55vw, .875rem)",
    eyebrow: `italic 400 1.125rem/1.4 ${HEAD}`,
    eyebrowCase: "none",
    eyebrowTrack: "0",
    quoteWeight: "400",
    radius: "62.5rem",
    radiusCard: ".875rem",
    radiusPaper: ".75rem",
    ruleH: "2px",
    ruleW: "1.75rem",
  },
};

const kebab = (key: string) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** The page's Classic custom properties, --aw-refined-<token>, for its palette and lettering. */
export function variables(theme: Theme): Readonly<Record<string, string>> {
  const tokens: Record<string, string> = { ...PALETTES[theme.palette], ...LETTERING[theme.font] };
  return Object.fromEntries(Object.entries(tokens).map(([key, value]) => [`--aw-refined-${kebab(key)}`, value]));
}
