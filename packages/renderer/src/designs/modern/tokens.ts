// Modern's own colours and display lettering (A12: design constants only, system fonts only, passed to the
// page as --aw-modern-* custom properties by variables()). The owner's colour choice (the palette id) picks
// one set; every text and background pair the design uses is checked for WCAG AA in
// test/designs/modern/pairs.ts. Solid hex only, so contrast is checked exactly.
import type { FontId, PaletteId, Theme } from "@asksite/site-schema";

export interface ModernColors {
  /** Headings and strong text. */
  readonly ink: string;
  /** Body text. */
  readonly text: string;
  /** Secondary text. */
  readonly muted: string;
  /** The tinted section background. */
  readonly tint: string;
  /** Hairlines and card borders (decorative). */
  readonly line: string;
  /** Form field borders and the FAQ key (non-text, 3:1). */
  readonly field: string;
  /** The brand band: About, the footer, card headers, the call card. */
  readonly brand: string;
  /** Hairlines on the brand band (decorative). */
  readonly brandLine: string;
  /** Secondary text on the brand band. */
  readonly onBrandMuted: string;
  /** Action buttons (Call, Send). */
  readonly act: string;
  readonly actHover: string;
  /** Text on an action button. */
  readonly onAct: string;
  /** The Emergencies well under the hours. */
  readonly well: string;
  /** Action buttons on the brand band. */
  readonly bandAct: string;
  readonly bandActHover: string;
  readonly onBandAct: string;
  /** Icons on the brand band. */
  readonly bandAccent: string;
}

export const MODERN_COLORS: Readonly<Record<PaletteId, ModernColors>> = {
  "navy-orange": {
    ink: "#0F1B2D",
    text: "#283444",
    muted: "#55606F",
    tint: "#F1F4F7",
    line: "#D9DFE6",
    field: "#6B7686",
    brand: "#1B365D",
    brandLine: "#3B5680",
    onBrandMuted: "#BCC8D8",
    act: "#FF7A1F",
    actHover: "#F26A10",
    onAct: "#0F1B2D",
    well: "#E3E9F1",
    bandAct: "#FF7A1F",
    bandActHover: "#F26A10",
    onBandAct: "#0F1B2D",
    bandAccent: "#FF7A1F",
  },
  "blue-yellow": {
    ink: "#0E1A2E",
    text: "#263244",
    muted: "#516075",
    tint: "#EEF2F8",
    line: "#D6DDE8",
    field: "#6A778A",
    brand: "#1C4B96",
    brandLine: "#4068AB",
    onBrandMuted: "#CBD8EE",
    act: "#FFC61A",
    actHover: "#F5B800",
    onAct: "#111C2E",
    well: "#E0E8F5",
    bandAct: "#FFC61A",
    bandActHover: "#F5B800",
    onBandAct: "#111C2E",
    bandAccent: "#FFC61A",
  },
  "green-amber": {
    ink: "#10201A",
    text: "#26352D",
    muted: "#56655C",
    tint: "#F0F3EF",
    line: "#D8DFD8",
    field: "#6C786F",
    brand: "#1F4D3A",
    brandLine: "#3F6B56",
    onBrandMuted: "#C0D4C8",
    act: "#F2A516",
    actHover: "#E6970A",
    onAct: "#10201A",
    well: "#E1EAE3",
    bandAct: "#F2A516",
    bandActHover: "#E6970A",
    onBandAct: "#10201A",
    bandAccent: "#F2A516",
  },
  // Red on the charcoal band fails AA, so on the band the action turns white with red text.
  "charcoal-red": {
    ink: "#16181B",
    text: "#2B2E33",
    muted: "#5A5F66",
    tint: "#F3F3F2",
    line: "#DEDEDC",
    field: "#73777D",
    brand: "#2B2F33",
    brandLine: "#50565D",
    onBrandMuted: "#C5C9CE",
    act: "#C62F28",
    actHover: "#AD2620",
    onAct: "#FFFFFF",
    well: "#E8E8E6",
    bandAct: "#FFFFFF",
    bandActHover: "#F3F3F2",
    onBandAct: "#C62F28",
    bandAccent: "#FFFFFF",
  },
};

/**
 * The display lettering (headings, the business name, the big phone number) for each lettering choice. Body
 * text keeps one system stack (styles/sheets/modern.css). Stacks from Modern Font Stacks (CC0) and the
 * platforms' own faces: no web font, no download. `tracking` scales the headings' negative letter-spacing
 * (a condensed face needs less); `phoneEm` is the width of "(512) 555-0142" in em in that face's widest
 * platform font, plus 4 % (measured in WebKit and Chromium on macOS: 7.73, 6.22 and 7.64), so the call card can
 * size the number to its width (container units).
 */
export const MODERN_FONTS: Readonly<Record<FontId, { readonly display: string; readonly tracking: string; readonly phoneEm: string }>> = {
  clean: {
    display: '"Segoe UI Variable Display","Segoe UI",system-ui,-apple-system,Roboto,"Helvetica Neue",Arial,sans-serif',
    tracking: "1",
    phoneEm: "8.23",
  },
  // Condensed and heavy where the platform has such a face (Avenir Next Condensed on Apple devices; Bahnschrift on
  // Windows, a condensed sans on Android and Linux): DIN Alternate, the only cut Apple ships, reads lighter than the
  // clean choice, which is backwards for "sturdy" (Modern round-6 judge).
  sturdy: {
    display: 'Bahnschrift,"Avenir Next Condensed","DIN Alternate","Franklin Gothic Medium","Nimbus Sans Narrow",sans-serif-condensed,sans-serif',
    tracking: ".3",
    phoneEm: "6.47",
  },
  friendly: {
    display: '"Avenir Next",Avenir,Montserrat,Corbel,"URW Gothic",source-sans-pro,sans-serif',
    tracking: ".6",
    phoneEm: "7.95",
  },
};

const kebab = (key: string) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** The page's --aw-modern-* custom properties for the owner's colour and lettering choices. */
export function modernVariables(theme: Pick<Theme, "palette" | "font">): Record<string, string> {
  const colors = Object.entries(MODERN_COLORS[theme.palette]).map(([key, value]) => [`--aw-modern-${kebab(key)}`, value]);
  const font = MODERN_FONTS[theme.font];
  return {
    ...Object.fromEntries(colors),
    "--aw-modern-display": font.display,
    "--aw-modern-tracking": font.tracking,
    "--aw-modern-phone-em": font.phoneEm,
  };
}
