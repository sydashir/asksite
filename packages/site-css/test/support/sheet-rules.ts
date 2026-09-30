import { posix } from "node:path";
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
 *
 * KNOWN LIMIT: a CSS-escaped url( (for example `u\72l(`) is not seen here. Backstops: every sheet byte is
 * locked (packages/site-css/sheets/<id>.sha256) and reviewed, and the public page and the admin review
 * page are served with CSP default-src 'none' (Plan 2B apps/sites/src/headers.ts, Plan 4
 * packages/app-common/src/http.ts), so such a url() fetches nothing there.
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
