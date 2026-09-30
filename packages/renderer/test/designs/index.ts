import type { DesignId } from "@asksite/site-schema";
import type { Palette } from "../../src/theme.ts";
import type { Pair } from "./baseline-pairs.ts";
import { pairs as impact } from "./impact/pairs.ts";
import { pairs as modern } from "./modern/pairs.ts";
import { pairs as refined } from "./refined/pairs.ts";

/** Each design's contrast pairs (A12). A design build changes only its own folder's pairs.ts. */
export const DESIGN_PAIRS: Readonly<Record<DesignId, (palette: Palette) => Pair[]>> = { impact, refined, modern };
