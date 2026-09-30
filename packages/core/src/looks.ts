import type { Theme } from "@asksite/site-schema";

/**
 * Colour presets the owner can switch between in the editor (Plan 1 proves their contrast). Owners see the
 * name; the ids are internal and permanent, never shown on an owner or admin screen (A12: the design names
 * "Bold" and "Classic" equal two of them).
 */
export const LOOKS = [
  { id: "classic", name: "Navy & orange", theme: { palette: "navy-orange", font: "clean" } },
  { id: "bright", name: "Blue & yellow", theme: { palette: "blue-yellow", font: "friendly" } },
  { id: "outdoor", name: "Green & amber", theme: { palette: "green-amber", font: "sturdy" } },
  { id: "bold", name: "Charcoal & red", theme: { palette: "charcoal-red", font: "sturdy" } },
] as const satisfies ReadonlyArray<{ id: string; name: string; theme: Pick<Theme, "palette" | "font"> }>;
