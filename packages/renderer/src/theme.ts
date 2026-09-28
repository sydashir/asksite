import type { FontId, PaletteId, Theme } from "@asksite/site-schema";
import { SafeHtml } from "./html.ts";

export interface Palette {
  primary: string;
  secondary: string;
  accent: string;
  textHeading: string;
  textDefault: string;
  textMuted: string;
  bgPage: string;
  bgPageDark: string;
  link: string;
}

export interface FontPreset {
  sans: string;
  serif: string;
  heading: string;
}

// Solid hex only (no alpha), so contrast can be checked exactly. Every text/background pair
// the templates use is asserted to pass WCAG AA in test/theme.test.ts.
export const PALETTES: Record<PaletteId, Palette> = {
  "navy-orange": {
    primary: "#1D4ED8",
    secondary: "#1E3A8A",
    accent: "#F97316",
    textHeading: "#0B1220",
    textDefault: "#1F2937",
    textMuted: "#4B5563",
    bgPage: "#FFFFFF",
    bgPageDark: "#0B1F3A",
    link: "#1D4ED8",
  },
  "blue-yellow": {
    primary: "#0B5CAD",
    secondary: "#08467F",
    accent: "#FACC15",
    textHeading: "#0A1628",
    textDefault: "#1E293B",
    textMuted: "#475569",
    bgPage: "#FFFFFF",
    bgPageDark: "#0A1F33",
    link: "#0B5CAD",
  },
  "green-amber": {
    primary: "#15803D",
    secondary: "#166534",
    accent: "#F59E0B",
    textHeading: "#0C1A12",
    textDefault: "#1C2B22",
    textMuted: "#4A5A50",
    bgPage: "#FCFCF9",
    bgPageDark: "#0F2A1D",
    link: "#15803D",
  },
  "charcoal-red": {
    primary: "#B91C1C",
    secondary: "#991B1B",
    accent: "#FBBF24",
    textHeading: "#111111",
    textDefault: "#262626",
    textMuted: "#525252",
    bgPage: "#FFFFFF",
    bgPageDark: "#1C1C1E",
    link: "#B91C1C",
  },
};

// System font stacks from modern-font-stacks (CC0). No web-font download, no third-party request.
const SYSTEM_UI = "system-ui, sans-serif";
const TRANSITIONAL = "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, serif";

export const FONTS: Record<FontId, FontPreset> = {
  clean: {
    sans: SYSTEM_UI,
    serif: TRANSITIONAL,
    heading: "Inter, Roboto, 'Helvetica Neue', 'Arial Nova', 'Nimbus Sans', Arial, sans-serif",
  },
  sturdy: {
    sans: SYSTEM_UI,
    serif: TRANSITIONAL,
    heading: "Bahnschrift, 'DIN Alternate', 'Franklin Gothic Medium', 'Nimbus Sans Narrow', sans-serif-condensed, sans-serif",
  },
  friendly: {
    sans: "Seravek, 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', source-sans-pro, sans-serif",
    serif: TRANSITIONAL,
    heading: "Avenir, Montserrat, Corbel, 'URW Gothic', source-sans-pro, sans-serif",
  },
};

/** The 12 per-site CSS custom properties (3 fonts + 9 colours) read by the shared stylesheet. */
export function themeVariables(theme: Pick<Theme, "palette" | "font">): Record<string, string> {
  const p = PALETTES[theme.palette];
  const f = FONTS[theme.font];
  return {
    "--aw-font-sans": f.sans,
    "--aw-font-serif": f.serif,
    "--aw-font-heading": f.heading,
    "--aw-color-primary": p.primary,
    "--aw-color-secondary": p.secondary,
    "--aw-color-accent": p.accent,
    "--aw-color-text-heading": p.textHeading,
    "--aw-color-text-default": p.textDefault,
    "--aw-color-text-muted": p.textMuted,
    "--aw-color-bg-page": p.bgPage,
    "--aw-color-bg-page-dark": p.bgPageDark,
    "--aw-color-link": p.link,
  };
}

/**
 * Inline <style> block for the page head: the 12 per-site properties, then the design's own (A12), in
 * one :root rule. Values are our own constants, never user input.
 */
export function themeStyle(theme: Pick<Theme, "palette" | "font">, extras: Readonly<Record<string, string>> = {}): SafeHtml {
  const declarations = Object.entries({ ...themeVariables(theme), ...extras })
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  return new SafeHtml(`<style>:root{${declarations}}</style>`);
}
