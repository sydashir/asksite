// WCAG 2.2 relative luminance and contrast ratio.
// https://www.w3.org/TR/WCAG22/#dfn-relative-luminance and #dfn-contrast-ratio
export type Rgb = readonly [r: number, g: number, b: number];

export const AA_NORMAL_TEXT = 4.5;
export const AA_LARGE_TEXT = 3;

export function hexToRgb(hex: string): Rgb {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`Expected #RRGGBB, got ${JSON.stringify(hex)}`);
  return [parseInt(match[1] ?? "", 16), parseInt(match[2] ?? "", 16), parseInt(match[3] ?? "", 16)];
}

function channel(c8: number): number {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
