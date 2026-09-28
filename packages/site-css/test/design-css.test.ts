import { existsSync, readdirSync, readFileSync } from "node:fs";
import { sha256Hex } from "@asksite/core";
import { DESIGN_IDS } from "@asksite/site-schema";
import { describe, expect, it } from "vitest";
import { DESIGN_CSS, SITE_CSS, SITE_CSS_SHA256 } from "../src/index.ts";
import { FOCUS_OUTSIDE_RULE, sheetProblems, sourceProblems } from "./support/sheet-rules.ts";

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

  it.each(DESIGN_IDS)("%s: equals its lock, sheets/%s.sha256, so a build that changes another design's sheet fails here", (id) => {
    expect(DESIGN_CSS[id].sha256).toBe(read(`../sheets/${id}.sha256`, import.meta.url).trim());
  });

  it("has exactly one lock per design", () => {
    expect(readdirSync(new URL("../sheets/", import.meta.url)).sort()).toEqual(DESIGN_IDS.map((id) => `${id}.sha256`).sort());
  });

  it.each(DESIGN_IDS)("%s: inlines safely, fetches nothing, keeps the focus-outside rule and fits the budget", (id) => {
    expect(sheetProblems(DESIGN_CSS[id].css)).toEqual([]);
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

  it.each(SHEETS)("%s scans only render.ts, the shared rules and its own design", (file) => {
    expect(sourceProblems(file.replace(/\.css$/, ""), read(`sheets/${file}`, STYLES))).toEqual([]);
  });
});

describe("the sheet checks can fail (RED proof)", () => {
  const good = `/*! tailwindcss v4.3.3 */${FOCUS_OUTSIDE_RULE}`;

  it("pass a good sheet", () => {
    expect(sheetProblems(good)).toEqual([]);
  });

  it.each([
    ["</style", `${good}</STYLE><script>`],
    ["url(", `${good}.a{background:URL(x.png)}`],
    ["@import", `@import "x.css";${good}`],
    ["image-set(", `${good}.a{background:image-set("x.png" 1x)}`],
    ["@font-face", `${good}@font-face{font-family:x}`],
    ["no focus-outside rule", good.replace("position:static", "position:sticky")],
  ])("catch %s", (problem, css) => {
    expect(sheetProblems(css)).toEqual([problem]);
  });

  it("catch a sheet over the raw and the gzip budget", () => {
    const noise = Array.from({ length: 6000 }, (_, i) => `.c${(i * 7919) % 100_003}{order:${i}}`).join("");
    expect(sheetProblems(good + noise).map((p) => p.replace(/^\d+/, "N"))).toEqual(["N B raw > 40960", "N B gzip > 8192"]);
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
});
