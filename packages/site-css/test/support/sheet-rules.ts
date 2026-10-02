import { posix } from "node:path";
import { gzipSync } from "node:zlib";
import type { DesignId } from "@asksite/site-schema";

/** One row of the budget table: the sheet's raw and gzip-9 budget, and the one @font-face it may embed, if any. */
export interface SheetBudget {
  readonly raw: number;
  readonly gzip: number;
  /** The only @font-face this design's sheet may hold (matched whole); every other design has none. */
  readonly font?: RegExp;
}

// USER DECISION 2026-09-27 (A12.md): Bold (impact) embeds one heading font, Archivo Condensed ExtraBold, as a data:
// woff2 in its own sheet: the family Archivo Condensed, one src that is a base64 data:font/woff2 URI, and plain
// descriptors (no other url(), no local(), no second source). Anything else is left in the sheet and refused.
const ARCHIVO_CONDENSED_FACE =
  /@font-face\s*\{\s*font-family:\s*(?:"Archivo Condensed"|Archivo Condensed)\s*;\s*src:\s*url\(\s*data:font\/woff2;base64,[A-Za-z0-9+/]+={0,2}\s*\)\s*format\(\s*"woff2"\s*\)\s*(?:;\s*(?:font-weight|font-style|font-stretch|font-display)\s*:\s*[a-z0-9%. ]+\s*)*;?\s*\}/i;

// The budget of each compiled design sheet, every page inlines it (moderator rulings 2026-09-26 and M4, A16, 2026-10-01):
// one row per design. Refined and Modern get 9 KiB gzip for the page-level markup A16 adds; Bold's row (its sync,
// moderator ruling 2026-10-01) is 64 KiB raw / 24 KiB gzip with its one embedded font. Today's baseline sheet is
// 26 KB raw, 5.7 KB gzip-9, inside every row.
export const SHEET_BUDGET: Readonly<Record<DesignId, SheetBudget>> = {
  impact: { raw: 64 * 1024, gzip: 24 * 1024, font: ARCHIVO_CONDENSED_FACE },
  refined: { raw: 40 * 1024, gzip: 9 * 1024 },
  modern: { raw: 40 * 1024, gzip: 9 * 1024 },
};

// The compiled focus-outside variant (styles/shared.css): the call bar stops sticking while keyboard focus
// is outside it, so it never hides the focused element (WCAG 2.4.11). Every design needs it.
export const FOCUS_OUTSIDE_RULE = String.raw`html:has(:focus-visible:not(aside *)) .focus-outside\:static{position:static}`;

/**
 * What is wrong with a compiled sheet that every page inlines: it must not close its <style>, must fetch
 * nothing (no url(), @import, image-set() or @font-face: the page's CSP and html_sha256 cover only the
 * page), must carry the focus-outside rule and must fit its design's budget row. A row's one embedded font is
 * the only exception: that one @font-face, once (the page's CSP then needs font-src data:).
 *
 * KNOWN LIMIT: a CSS-escaped url( (for example `u\72l(`) is not seen here. Backstops: every sheet byte is
 * locked (packages/site-css/sheets/<id>.sha256) and reviewed, and the public page and the admin review
 * page are served with CSP default-src 'none' (Plan 2B apps/sites/src/headers.ts, Plan 4
 * packages/app-common/src/http.ts), so such a url() fetches nothing there.
 */
export function sheetProblems(css: string, design: DesignId): string[] {
  const budget = SHEET_BUDGET[design];
  const checked = budget.font === undefined ? css : css.replace(budget.font, "");
  const problems: string[] = [];
  if (/<\/style/i.test(css)) problems.push("</style");
  for (const [label, pattern] of [
    ["url(", /url\(/i],
    ["@import", /@import/i],
    ["image-set(", /image-set\(/i],
    ["@font-face", /@font-face/i],
  ] as const) {
    if (pattern.test(checked)) problems.push(label);
  }
  if (!css.includes(FOCUS_OUTSIDE_RULE)) problems.push("no focus-outside rule");
  const raw = Buffer.byteLength(css, "utf8");
  if (raw > budget.raw) problems.push(`${raw} B raw > ${budget.raw}`);
  const gzip = gzipSync(css, { level: 9 }).length;
  if (gzip > budget.gzip) problems.push(`${gzip} B gzip > ${budget.gzip}`);
  return problems;
}

// The only imports a Tailwind input may have: Tailwind with automatic scanning off, and the shared tokens.
const IMPORTS: readonly string[] = ['@import "tailwindcss" source(none);', '@import "../shared.css";'];

/**
 * A @source path as the renderer package sees it: Tailwind resolves @source relative to the stylesheet
 * (tailwindcss.com/docs/detecting-classes-in-source-files), and every input is in styles/sheets/.
 */
const inPackage = (path: string) => posix.normalize(path.startsWith("/") ? path : `styles/sheets/${path}`).replace(/\/+$/, "");

/** render.ts and the shared modules any design may reuse: every path under src/ outside src/designs. */
const isShared = (path: string) => path.startsWith("src/") && path !== "src/designs" && !path.startsWith("src/designs/");

const shown = (path: string) => (path.startsWith("not ") ? `not ../../${path.slice(4)}` : `../../${path}`);

/**
 * What is wrong with a Tailwind input, packages/renderer/styles/sheets/<name>.css (A12 addendum; A12-0
 * round-2 rulings). Each one turns off automatic scanning and imports the shared tokens, and nothing else:
 * no other @import, @reference, @config or @plugin. Each @source is the house form, `@source ["not"]
 * "<path>";` with double quotes and no glob, and its path is normalised before it is judged. The baseline
 * scans src but not src/designs, and nothing more; a design scans render.ts and its own folder, and may
 * add the shared modules (src/ outside src/designs). So no design's classes ever reach another design's
 * sheet. Directives inside comments are ignored, as Tailwind ignores them.
 */
export function sourceProblems(name: string, source: string): string[] {
  // Comments go (Tailwind reads no directive in one); a "/*" inside a quoted path is not a comment.
  const css = source.replace(/("[^"]*"|'[^']*')|\/\*[\s\S]*?\*\//g, (_, quoted: string | undefined) => quoted ?? "");
  const statements = [...css.matchAll(/@(?:import|reference|config|plugin|source)\b[^;]*;?/g)].map((m) => m[0].replace(/\s+/g, " ").trim());
  const found: Array<{ written: string; path: string }> = [];
  const wrong: string[] = [];
  for (const statement of statements) {
    if (!statement.startsWith("@source")) {
      if (!IMPORTS.includes(statement)) wrong.push(`imports ${statement}`);
      continue;
    }
    const match = /^@source (not )?"([^"]*)";$/.exec(statement);
    if (match === null) {
      wrong.push(`unreadable ${statement}`);
      continue;
    }
    const [, not = "", path = ""] = match;
    if (/[*?{}[\]\\!]/.test(path)) wrong.push(`glob ${not}${path}`);
    else found.push({ written: `${not}${path}`, path: `${not}${inPackage(path)}` });
  }

  const own = name === "baseline" ? ["src", "not src/designs"] : ["src/render.ts", `src/designs/${name}`];
  // Judged in lower case: this Mac's APFS volume is case-insensitive, so "src/Designs/impact" scans
  // src/designs/impact here (A12-0 round-4 rulings, M1). Each required path must still be written exactly,
  // as a case-sensitive Linux build reads it.
  const allowed = (path: string): boolean => {
    const judged = path.toLowerCase();
    if (name === "baseline") return own.includes(judged);
    const target = judged.replace(/^not /, "");
    return target === own[1] || target.startsWith(`${own[1]}/`) || isShared(target);
  };
  return [
    ...IMPORTS.filter((line) => !statements.includes(line)).map((line) => `missing ${line}`),
    ...own.filter((path) => !found.some((f) => f.path === path)).map((path) => `missing @source ${shown(path)}`),
    ...wrong,
    ...found.filter((f) => !allowed(f.path)).map((f) => `scans ${f.written}`),
  ];
}
