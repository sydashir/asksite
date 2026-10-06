import { render } from "@asksite/renderer";
import { DESIGN_CSS } from "@asksite/site-css";
import type { Renderer } from "./preview.ts";

/** The lazy chunk's one entry: `render` and the design sheets. Only preview.ts imports it, and only dynamically. */
export const RENDERER: Renderer = { render, sheets: DESIGN_CSS };
