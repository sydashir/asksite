import { z } from "zod";

// Only the ids live in the schema. The renderer owns the actual colours and font stacks.
export const PALETTE_IDS = ["navy-orange", "blue-yellow", "green-amber", "charcoal-red"] as const;
export const FONT_IDS = ["clean", "sturdy", "friendly"] as const;

export const Theme = z.strictObject({ palette: z.enum(PALETTE_IDS), font: z.enum(FONT_IDS) });

export type Theme = z.infer<typeof Theme>;
export type PaletteId = Theme["palette"];
export type FontId = Theme["font"];
