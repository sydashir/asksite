// Three Tabler icons the shared set (src/icons.ts) does not have, drawn the same way: 24x24, stroke-based,
// currentColor, decorative. Each path joins the subpaths of the icon's own SVG at Tabler Icons v3.48.0
// (icons/outline/<name>.svg, MIT, Copyright (c) 2020-2026 Paweł Kuna; NOTICES.md). Each is one whole string
// literal, as the design-source guard asks.
import { trusted, type SafeHtml } from "../../html.ts";

/** Tabler "calendar": the founding year. */
export const CALENDAR: SafeHtml = trusted('<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12M16 3v4M8 3v4M4 11h16M11 15h1M12 15v3"/></svg>');

/** Tabler "building": the office address. */
export const BUILDING: SafeHtml = trusted('<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 21l18 0M9 8l1 0M9 12l1 0M9 16l1 0M14 8l1 0M14 12l1 0M14 16l1 0M5 21v-16a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v16"/></svg>');

/** Tabler "arrow-down": a jump further down the page (the footer's full list of licenses). */
export const ARROW_DOWN: SafeHtml = trusted('<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5l0 14M18 13l-6 6M6 13l6 6"/></svg>');
