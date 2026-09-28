import { gzipSync } from "node:zlib";

// A12 budget per compiled design sheet (moderator, 2026-09-26): today's sheet is 25,817 B raw, 5,665 B gzip-9.
export const SHEET_BUDGET = { raw: 40 * 1024, gzip: 8 * 1024 } as const;

// The compiled focus-outside variant (styles/shared.css): the call bar stops sticking while keyboard focus
// is outside it, so it never hides the focused element (WCAG 2.4.11). Every design needs it.
export const FOCUS_OUTSIDE_RULE = String.raw`html:has(:focus-visible:not(aside *)) .focus-outside\:static{position:static}`;

/**
 * What is wrong with a compiled sheet that every page inlines: it must not close its <style>, must fetch
 * nothing (no url(), @import, image-set() or @font-face: the page's CSP and html_sha256 cover only the
 * page), must carry the focus-outside rule and must fit the budget.
 */
export function sheetProblems(css: string): string[] {
  const problems: string[] = [];
  if (/<\/style/i.test(css)) problems.push("</style");
  for (const [label, pattern] of [
    ["url(", /url\(/i],
    ["@import", /@import/i],
    ["image-set(", /image-set\(/i],
    ["@font-face", /@font-face/i],
  ] as const) {
    if (pattern.test(css)) problems.push(label);
  }
  if (!css.includes(FOCUS_OUTSIDE_RULE)) problems.push("no focus-outside rule");
  const raw = Buffer.byteLength(css, "utf8");
  if (raw > SHEET_BUDGET.raw) problems.push(`${raw} B raw > ${SHEET_BUDGET.raw}`);
  const gzip = gzipSync(css, { level: 9 }).length;
  if (gzip > SHEET_BUDGET.gzip) problems.push(`${gzip} B gzip > ${SHEET_BUDGET.gzip}`);
  return problems;
}

/**
 * What is wrong with a Tailwind input, packages/renderer/styles/sheets/<name>.css. Each one turns off
 * automatic scanning, imports the shared tokens and utilities, and scans render.ts (the page shell) plus
 * either every source but the design folders (baseline) or its own design folder only. So no design's
 * classes ever reach another design's sheet (A12 addendum).
 */
export function sourceProblems(name: string, source: string): string[] {
  const lines = new Set(source.split("\n").map((line) => line.trim()));
  const problems: string[] = [];
  for (const line of ['@import "tailwindcss" source(none);', '@import "../shared.css";']) {
    if (!lines.has(line)) problems.push(`missing ${line}`);
  }
  const sources = [...source.matchAll(/@source\s+(not\s+)?"([^"]*)"/g)].map((m) => `${m[1] ? "not " : ""}${m[2]}`);
  const own = name === "baseline" ? ["../../src", "not ../../src/designs"] : ["../../src/render.ts", `../../src/designs/${name}`];
  for (const path of own) if (!sources.includes(path)) problems.push(`missing @source ${path}`);
  const allowed = new Set([...own, "../../src/render.ts"]);
  for (const path of sources) {
    if (!allowed.has(path) && (path === "../../src" || path.startsWith("../../src/designs"))) problems.push(`scans ${path}`);
  }
  return problems;
}
