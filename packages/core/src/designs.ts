import type { DesignId, Trade } from "@asksite/site-schema";

/** The page designs owners choose between (A12), in DESIGN_IDS order. The id is stored; the name is shown. */
export const PAGE_DESIGNS = [
  { id: "impact", name: "Bold" },
  { id: "refined", name: "Classic" },
  { id: "modern", name: "Modern" },
] as const satisfies ReadonlyArray<{ id: DesignId; name: string }>;

/**
 * Every draft starts on its trade's design, whether the model or the template wrote it (user decision
 * 2026-09-26). The model never chooses the design; the owner can switch it at any time.
 */
export const DESIGN_FOR_TRADE = {
  plumbing: "impact",
  hvac: "impact",
  electrical: "impact",
  roofing: "refined",
  landscaping: "refined",
  cleaning: "modern",
  it: "modern",
  law: "refined",
  other: "modern",
} as const satisfies Record<Trade, DesignId>;

/** The design a new draft for this trade gets. */
export function designForTrade(trade: Trade): DesignId {
  return DESIGN_FOR_TRADE[trade];
}
