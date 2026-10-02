import { existsSync, readdirSync, readFileSync } from "node:fs";
import { sha256Hex } from "@asksite/core";
import { gzipSync } from "node:zlib";
import { DESIGN_IDS, type DesignId } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { DESIGN_CSS, SITE_CSS, SITE_CSS_SHA256 } from "../src/index.ts";
import { FOCUS_OUTSIDE_RULE, SHEET_BUDGET, sheetProblems, sourceProblems } from "./support/sheet-rules.ts";

const STYLES = new URL("../../renderer/styles/", import.meta.url);
const SHEETS = readdirSync(new URL("sheets/", STYLES)).filter((file) => file.endsWith(".css"));
const read = (path: string, base: URL | string) => readFileSync(new URL(path, base), "utf8");

describe("DESIGN_CSS (A12)", () => {
  it("has a sheet for every design and nothing else", () => {
    expect(Object.keys(DESIGN_CSS)).toEqual([...DESIGN_IDS]);
  });

  it.each(DESIGN_IDS)("%s: is its own compiled sheet if styles/sheets/<id>.css exists, otherwise the baseline", (id) => {
    const sheet = existsSync(new URL(`sheets/${id}.css`, STYLES)) ? id : "baseline";
    expect(DESIGN_CSS[id].css).toBe(read(`out/${sheet}.css`, STYLES));
    expect(DESIGN_CSS[id].css).toContain("tailwindcss v4.3.3");
  });

  it.each(DESIGN_IDS)("%s: carries the SHA-256 that core's sha256Hex computes", async (id) => {
    expect(DESIGN_CSS[id].sha256).toBe(await sha256Hex(DESIGN_CSS[id].css));
  });

  it.each(DESIGN_IDS)("%s: equals its lock in packages/site-css/sheets/, so a build that changes another design's sheet fails here", (id) => {
    expect(DESIGN_CSS[id].sha256).toBe(read(`../sheets/${id}.sha256`, import.meta.url).trim());
  });

  it("has exactly one lock per design", () => {
    expect(readdirSync(new URL("../sheets/", import.meta.url)).sort()).toEqual(DESIGN_IDS.map((id) => `${id}.sha256`).sort());
  });

  it.each(DESIGN_IDS)("%s: inlines safely, fetches nothing, keeps the focus-outside rule and fits the budget", (id) => {
    expect(sheetProblems(DESIGN_CSS[id].css, id)).toEqual([]);
  });

  it("keeps the baseline sheet within every design's budget row", () => {
    const baseline = read("out/baseline.css", STYLES);
    expect(DESIGN_IDS.map((id) => sheetProblems(baseline, id))).toEqual(DESIGN_IDS.map(() => []));
  });

  it("has one budget row per design: Bold 64 KiB raw / 24 KiB gzip with its one font, Classic and Modern 40 / 9 KiB and no font", () => {
    expect(SHEET_BUDGET).toEqual({ impact: { raw: 65536, gzip: 24576, font: expect.any(RegExp) }, refined: { raw: 40960, gzip: 9216 }, modern: { raw: 40960, gzip: 9216 } });
    expect(Object.keys(SHEET_BUDGET)).toEqual([...DESIGN_IDS]);
  });

  it("writes identical sheets once: designs share an object exactly when they share the css", () => {
    for (const a of DESIGN_IDS) {
      for (const b of DESIGN_IDS) expect(DESIGN_CSS[a] === DESIGN_CSS[b]).toBe(DESIGN_CSS[a].css === DESIGN_CSS[b].css);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(DESIGN_CSS)).toBe(true);
    for (const id of DESIGN_IDS) expect(Object.isFrozen(DESIGN_CSS[id])).toBe(true);
  });

  it("keeps SITE_CSS and SITE_CSS_SHA256 as deprecated aliases of the impact sheet until A12-R (A12 addendum H2)", () => {
    expect(SITE_CSS).toBe(DESIGN_CSS.impact.css);
    expect(SITE_CSS_SHA256).toBe(DESIGN_CSS.impact.sha256);
  });
});

describe("the Tailwind inputs, styles/sheets/*.css (A12)", () => {
  it("are the baseline plus only design ids", () => {
    const allowed = new Set(["baseline.css", ...DESIGN_IDS.map((id) => `${id}.css`)]);
    expect(SHEETS).toContain("baseline.css");
    expect(SHEETS.filter((file) => !allowed.has(file))).toEqual([]);
  });

  it.each(SHEETS)("%s scans only render.ts, the shared modules and its own design folder", (file) => {
    expect(sourceProblems(file.replace(/\.css$/, ""), read(`sheets/${file}`, STYLES))).toEqual([]);
  });
});

describe("the sheet checks can fail (RED proof)", () => {
  const good = `/*! tailwindcss v4.3.3 */${FOCUS_OUTSIDE_RULE}`;

  it("pass a good sheet", () => {
    expect(sheetProblems(good, "impact")).toEqual([]);
  });

  it.each([
    ["</style", `${good}</STYLE><script>`],
    ["url(", `${good}.a{background:URL(x.png)}`],
    ["@import", `@import "x.css";${good}`],
    ["image-set(", `${good}.a{background:image-set("x.png" 1x)}`],
    ["@font-face", `${good}@font-face{font-family:x}`],
    ["no focus-outside rule", good.replace("position:static", "position:sticky")],
  ])("catch %s", (problem, css) => {
    expect(sheetProblems(css, "impact")).toEqual([problem]);
  });

  it("catch a sheet over the raw and the gzip budget", () => {
    const noise = Array.from({ length: 6000 }, (_, i) => `.c${(i * 7919) % 100_003}{order:${i}}`).join("");
    const normal = (design: DesignId) => sheetProblems(good + noise, design).map((p) => p.replace(/^\d+/, "N"));
    expect(normal("impact")).toEqual(["N B raw > 65536", "N B gzip > 24576"]);
    expect(normal("refined")).toEqual(["N B raw > 40960", "N B gzip > 9216"]);
    expect(normal("modern")).toEqual(["N B raw > 40960", "N B gzip > 9216"]);
  });

  it("catch a sheet that fits Bold's gzip row but not Classic's", () => {
    // Between 9 and 24 KiB gzip: random-looking declarations that do not compress away.
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    let css = good;
    while (gzipSync(css, { level: 9 }).length <= 9216) css += `.c${next().toString(36)}{order:${next() % 1000}}`;
    const gzip = gzipSync(css, { level: 9 }).length;
    expect(gzip).toBeGreaterThan(9216);
    expect(gzip).toBeLessThanOrEqual(24576);
    expect(sheetProblems(css, "impact")).toEqual([]);
    expect(sheetProblems(css, "refined").map((p) => p.replace(/^\d+/, "N"))).toEqual(["N B gzip > 9216"]);
    expect(sheetProblems(css, "modern").map((p) => p.replace(/^\d+/, "N"))).toEqual(["N B gzip > 9216"]);
  });

  it("catch a Tailwind input that scans another design, or everything", () => {
    const design = '@import "tailwindcss" source(none);\n@import "../shared.css";\n@source "../../src/render.ts";\n@source "../../src/designs/modern";\n';
    expect(sourceProblems("modern", design)).toEqual([]);
    expect(sourceProblems("modern", `${design}@source "../../src/designs/impact";\n`)).toEqual(["scans ../../src/designs/impact"]);
    expect(sourceProblems("modern", `${design}@source "../../src";\n`)).toEqual(["scans ../../src"]);
    expect(sourceProblems("modern", `${design}@source "../../src/designs";\n`)).toEqual(["scans ../../src/designs"]);
    expect(sourceProblems("impact", design)).toEqual(["missing @source ../../src/designs/impact", "scans ../../src/designs/modern"]);
    expect(sourceProblems("baseline", '@import "tailwindcss" source(none);\n@import "../shared.css";\n@source "../../src";\n')).toEqual([
      "missing @source not ../../src/designs",
    ]);
    expect(sourceProblems("modern", design.replace('@import "../shared.css";\n', ""))).toEqual(['missing @import "../shared.css";']);
  });

  // A12-0 round-2 rulings: each @source path is normalised (Tailwind resolves it relative to the sheet),
  // and anything outside the design's own folder and the shared modules is refused, however it is written.
  const modern = '@import "tailwindcss" source(none);\n@import "../shared.css";\n@source "../../src/render.ts";\n@source "../../src/designs/modern";\n';

  it.each([
    ['@source "../../src/";', "scans ../../src/"],
    ['@source "../..";', "scans ../.."],
    ['@source "../../src/designs/modern/../impact";', "scans ../../src/designs/modern/../impact"],
    ['@source "../../src/sections/../designs";', "scans ../../src/sections/../designs"],
    ['@source "/Users/someone/src";', "scans /Users/someone/src"],
    ['@source not "../../src/designs/impact";', "scans not ../../src/designs/impact"],
    // This Mac's APFS volume is case-insensitive, so these name another design's folder, or all of them
    // (A12-0 round-4 rulings, M1).
    ['@source "../../src/Designs/impact";', "scans ../../src/Designs/impact"],
    ['@source "../../src/DESIGNS";', "scans ../../src/DESIGNS"],
    ['@source "../../src/designs/Impact/sections";', "scans ../../src/designs/Impact/sections"],
    ['@source "../../src/designs/modern/../IMPACT";', "scans ../../src/designs/modern/../IMPACT"],
    ['@source "../../src/**/*.ts";', "glob ../../src/**/*.ts"],
    ['@source "../../src/designs/{impact,modern}";', "glob ../../src/designs/{impact,modern}"],
    ["@source '../../src';", "unreadable @source '../../src';"],
    ['@source inline("bg-red-500");', 'unreadable @source inline("bg-red-500");'],
    ['@import "./impact.css";', 'imports @import "./impact.css";'],
    ['@import "../sheets/impact.css";', 'imports @import "../sheets/impact.css";'],
    ['@reference "./impact.css";', 'imports @reference "./impact.css";'],
    ['@config "../../tailwind.config.js";', 'imports @config "../../tailwind.config.js";'],
    ['@plugin "@tailwindcss/typography";', 'imports @plugin "@tailwindcss/typography";'],
  ])("catch %s", (line, problem) => {
    expect(sourceProblems("modern", `${modern}${line}\n`)).toEqual([problem]);
  });

  it("judge a path in lower case, and still need each required path written exactly, as a case-sensitive build reads it", () => {
    expect(sourceProblems("modern", modern.replace('"../../src/designs/modern"', '"../../src/designs/Modern"'))).toEqual(["missing @source ../../src/designs/modern"]);
    expect(sourceProblems("baseline", '@import "tailwindcss" source(none);\n@import "../shared.css";\n@source "../../SRC";\n@source not "../../src/designs";\n')).toEqual([
      "missing @source ../../src",
    ]);
  });

  it("catch Tailwind's automatic scanning left on", () => {
    expect(sourceProblems("modern", modern.replace(" source(none)", ""))).toEqual(['missing @import "tailwindcss" source(none);', 'imports @import "tailwindcss";']);
  });

  it("catch a baseline input that scans anything more", () => {
    const baseline = '@import "tailwindcss" source(none);\n@import "../shared.css";\n@source "../../src";\n@source not "../../src/designs";\n';
    expect(sourceProblems("baseline", baseline)).toEqual([]);
    expect(sourceProblems("baseline", `${baseline}@source "../../src/designs/impact";\n`)).toEqual(["scans ../../src/designs/impact"]);
  });

  it("allow the shared modules, sub-paths of the own folder and paths written another way that stay inside", () => {
    const shared =
      '@source "../../src/sections";\n@source "../../src/baseline.ts";\n@source "../../src/ui.ts";\n@source "../../src/./icons.ts";\n' +
      '@source "../../src/designs/modern/";\n@source not "../../src/designs/modern/draft.ts";\n/* @source "../../src"; Tailwind reads no directive in a comment */\n';
    expect(sourceProblems("modern", `${modern}${shared}`)).toEqual([]);
  });
});
