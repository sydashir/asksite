/**
 * Each page design's compiled stylesheet and its SHA-256 (stored on each version for audit). Pass
 * DESIGN_CSS to render(), which inlines the sheet of the page's own design (A12). DESIGN_SHOP_CSS holds each design's
 * shop sheet, which the shop render inlines as a second <style> only on pages that draw shop parts (option (a)).
 * SITE_CSS and SITE_CSS_SHA256 are deprecated aliases of the impact sheet (A12 addendum H2).
 */
export { DESIGN_CSS, DESIGN_SHOP_CSS, SITE_CSS, SITE_CSS_SHA256 } from "./generated.ts";
