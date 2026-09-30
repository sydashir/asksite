import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DESIGN_CSS } from "../../../../../fixtures/index.ts";
import { FOCUS_OUTSIDE_RULE, sheetProblems } from "../../../../site-css/test/support/sheet-rules.ts";

// USER DECISION 2026-09-27 (A12.md): Bold (impact) embeds Archivo Condensed ExtraBold as a data: woff2 in its own
// sheet only, for headings, buttons and prices, with its own budget of 64 KiB raw / 24 KiB gzip. Only that one
// @font-face is allowed, and only in the impact sheet; every other url() stays forbidden in every sheet.

const good = `/*! tailwindcss v4.3.3 */${FOCUS_OUTSIDE_RULE}`;
const face = (src: string, family = "Archivo Condensed") =>
  `@font-face{font-family:${family};src:${src};font-weight:800;font-style:normal;font-stretch:75%;font-display:swap}`;
const WOFF2 = 'url(data:font/woff2;base64,d09GMgABAAAAAC8sAA==)format("woff2")';

describe("the impact sheet's one embedded font (sheet-rules.ts)", () => {
  it("the real impact sheet passes, with its one @font-face and one url(", () => {
    const css = DESIGN_CSS.impact.css;
    expect(css.match(/@font-face/g)).toHaveLength(1);
    expect(css.match(/url\(/g)).toHaveLength(1);
    expect(sheetProblems(css)).toEqual([]);
  });

  it("allows one data:font/woff2 @font-face for Archivo Condensed in the impact sheet", () => {
    expect(sheetProblems(good + face(WOFF2), "impact")).toEqual([]);
    expect(sheetProblems(good + face(WOFF2, '"Archivo Condensed"'), "impact")).toEqual([]);
  });

  it.each(["refined", "modern", undefined] as const)("refuses the same @font-face in the %s sheet", (design) => {
    expect(sheetProblems(good + face(WOFF2), design)).toEqual(["url(", "@font-face"]);
  });

  it.each([
    ["a second @font-face", good + face(WOFF2) + face(WOFF2), ["url(", "@font-face"]],
    ["a font fetched over https", good + face('url(https://fonts.example.com/a.woff2)format("woff2")'), ["url(", "@font-face"]],
    ["a data: font of another type", good + face('url(data:font/ttf;base64,AAAA)format("truetype")'), ["url(", "@font-face"]],
    ["a data: woff2 with a second source", good + face(`${WOFF2},url(https://x.example/a.woff2)`), ["url(", "@font-face"]],
    ["another font family", good + face(WOFF2, "Anton"), ["url(", "@font-face"]],
    ["any other url()", good + face(WOFF2) + ".a{background:url(x.png)}", ["url("]],
    ["an @import", `@import "x.css";${good}${face(WOFF2)}`, ["@import"]],
  ])("refuses %s in the impact sheet", (_, css, problems) => {
    expect(sheetProblems(css, "impact")).toEqual(problems);
  });

  it("gives the impact sheet 64 KiB raw / 24 KiB gzip, and every other sheet 40 / 8", () => {
    const noise = (n: number) => Array.from({ length: n }, (_, i) => `.c${(i * 7919) % 100_003}{order:${i}}`).join("");
    const budget = (css: string, design?: "impact" | "refined") => sheetProblems(css, design).map((p) => p.replace(/^\d+/, "N"));
    expect(budget(good + noise(3000), "impact")).toEqual([]);
    expect(budget(good + noise(3000), "refined")).toEqual(["N B raw > 40960", "N B gzip > 8192"]);
    expect(budget(good + noise(9000), "impact")).toEqual(["N B raw > 65536", "N B gzip > 24576"]);
  });
});

describe("the embedded font", () => {
  const css = readFileSync(new URL("../../../styles/sheets/impact.css", import.meta.url), "utf8");
  const base64 = /url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/.exec(css)?.[1] ?? "";
  const bytes = Buffer.from(base64, "base64");

  it("is the reviewed Archivo Condensed ExtraBold Latin-1 subset (NOTICES.md: source, subset command and sha256)", () => {
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
    expect(bytes.length).toBe(12_076);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("da12957e6990ce2bdb70adec71ff73135879a71abe98ecb24ae902ea704a7c27");
  });

  it("travels with its copyright and licence notice in the compiled sheet (OFL 1.1, condition 2)", () => {
    const notice = /\/\*![^*]*Archivo[^*]*Copyright 2020 The Archivo Project Authors[^*]*SIL Open Font License, Version 1\.1[^*]*\*\//;
    expect(DESIGN_CSS.impact.css).toMatch(notice);
  });
});
