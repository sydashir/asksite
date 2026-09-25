import type { Theme } from "@asksite/site-schema";

/** Named theme presets the owner can switch between in the editor (Plan 1 proves their contrast). */
export const LOOKS = [
  { id: "classic", name: "Classic", theme: { palette: "navy-orange", font: "clean" } },
  { id: "bright", name: "Bright", theme: { palette: "blue-yellow", font: "friendly" } },
  { id: "outdoor", name: "Outdoor", theme: { palette: "green-amber", font: "sturdy" } },
  { id: "bold", name: "Bold", theme: { palette: "charcoal-red", font: "sturdy" } },
] as const satisfies ReadonlyArray<{ id: string; name: string; theme: Theme }>;
