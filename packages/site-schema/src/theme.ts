import { z } from "zod";

// Only the ids live in the schema. The renderer owns the actual colours and font stacks.
export const PALETTE_IDS = ["navy-orange", "blue-yellow", "green-amber", "charcoal-red"] as const;
export const FONT_IDS = ["clean", "sturdy", "friendly"] as const;

/**
 * Page designs (A12). Owners see them as "Bold", "Classic" and "Modern" (core PAGE_DESIGNS).
 * The ids are permanent: the list only grows. Renaming or removing an id, or changing DEFAULT_DESIGN,
 * needs a user-approved data migration of sites.edits_json, generations.output_json and
 * site_versions.document_json, which also changes document_sha256.
 */
export const DESIGN_IDS = ["impact", "refined", "modern"] as const;
export type DesignId = (typeof DESIGN_IDS)[number];
/** The design of a stored theme that names none (every theme saved before A12). */
export const DEFAULT_DESIGN: DesignId = "impact";

const colours = { palette: z.enum(PALETTE_IDS), font: z.enum(FONT_IDS) };

/** A theme in incoming data (a request body): it must name its design. */
export const ThemeChoice = z.strictObject({ ...colours, design: z.enum(DESIGN_IDS) });
/** A stored theme: one saved before designs existed gets DEFAULT_DESIGN. */
export const Theme = z.strictObject({ ...colours, design: z.enum(DESIGN_IDS).default(DEFAULT_DESIGN) });

export type ThemeChoice = z.infer<typeof ThemeChoice>;
export type Theme = z.infer<typeof Theme>;
export type PaletteId = Theme["palette"];
export type FontId = Theme["font"];
