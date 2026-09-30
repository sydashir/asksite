import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Long unbroken owner text (a web address in a review, a www business name, a 40-letter town) must never push the
// Bold page sideways or out of its cards (A12 section 13: reflow 320-1920 px, long names; WCAG 1.4.10). The page's
// overflow-wrap:break-word breaks such a word only inside a box of known width: its soft breaks do not count
// toward min-content (MDN overflow-wrap), and a grid column with an automatic minimum (auto, a bare fr, an implicit
// column) is as wide as its longest word (MDN minmax(), grid-template-columns). So every grid in the Bold sheet
// names its columns, and no column's minimum is sized by its content, except the two listed below.

interface Rule {
  readonly selectors: readonly string[];
  /** The enclosing @media / @container preludes (not @layer), "" at the top level. */
  readonly context: string;
  readonly decls: ReadonlyMap<string, string>;
}

/** The style rules of a flat stylesheet (at-rules may nest; style rules do not). */
function styleRules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const stack: string[] = [];
  let buffer = "";
  for (const ch of text) {
    if (ch === "{") {
      stack.push(buffer.trim());
      buffer = "";
    } else if (ch === "}") {
      const head = stack.pop() ?? "";
      if (head !== "" && !head.startsWith("@")) {
        const decls = new Map<string, string>();
        for (const decl of buffer.split(";")) {
          const colon = decl.indexOf(":");
          if (colon > 0) decls.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim().replace(/\s+/g, " "));
        }
        const context = stack.filter((h) => !h.startsWith("@layer")).join(" ");
        rules.push({ selectors: head.split(",").map((s) => s.trim().replace(/\s+/g, " ")), context, decls });
      }
      buffer = "";
    } else if (ch === ";" && !(stack.at(-1) ?? "@").match(/^[^@]/)) {
      buffer = ""; // a statement at the top level or directly inside an at-rule (@import, @source)
    } else buffer += ch;
  }
  return rules;
}

/** Splits a track list at its top-level spaces and commas (not inside brackets). */
function topLevel(value: string, separator: " " | ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let part = "";
  for (const ch of value) {
    depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
    if (ch === separator && depth === 0) {
      if (part.trim() !== "") parts.push(part.trim());
      part = "";
    } else part += ch;
  }
  if (part.trim() !== "") parts.push(part.trim());
  return parts;
}

const FIXED = /^(0|\d*\.?\d+(px|rem|em|%|ch|vw))$/;

/** The tracks of a column list whose minimum is sized by content: auto, a bare fr, min-/max-content, fit-content(). */
function contentSizedTracks(columns: string): string[] {
  return topLevel(columns, " ").flatMap((track): string[] => {
    const call = /^(repeat|minmax)\((.*)\)$/.exec(track);
    if (call?.[1] === "repeat") return contentSizedTracks(topLevel(call[2] ?? "", ",").slice(1).join(" "));
    if (call?.[1] === "minmax") return FIXED.test(topLevel(call[2] ?? "", ",")[0] ?? "") ? [] : [track];
    return FIXED.test(track) ? [] : [track];
  });
}

/** The column list of a rule: grid-template-columns, or the part of grid-template after "/". */
const columnsOf = (decls: ReadonlyMap<string, string>): string | undefined =>
  decls.get("grid-template-columns") ?? decls.get("grid-template")?.split("/")[1]?.trim();

// Deliberate content-sized minimums, each holding bounded house text, never free owner text.
const ALLOWED: Readonly<Record<string, string>> = {
  // The Call button: a formatted phone number that never wraps. It keeps its width; the short label gives way.
  ".callbar": "minmax(min-content, 1fr)",
  ".menu-acts": "minmax(min-content, 1fr)",
};

/** Every grid rule that leaves a column's width to its longest word. */
function trackProblems(css: string): string[] {
  const rules = styleRules(css);
  const problems: string[] = [];
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      if (rule.decls.get("display") === "grid") {
        const named = rules.some((r) => r.selectors.includes(selector) && (r.context === "" || r.context === rule.context) && columnsOf(r.decls) !== undefined);
        if (!named) problems.push(`${selector}${rule.context === "" ? "" : ` (${rule.context})`}: a grid with no column list`);
      }
      const columns = columnsOf(rule.decls);
      if (columns === undefined) continue;
      const loose = contentSizedTracks(columns).filter((track) => ALLOWED[selector]?.replace(/\s+/g, "") !== track.replace(/\s+/g, ""));
      if (loose.length > 0) problems.push(`${selector}${rule.context === "" ? "" : ` (${rule.context})`}: ${loose.join(", ")}`);
    }
  }
  return problems;
}

describe("the Bold sheet's grids never size a column by its longest word", () => {
  const source = readFileSync(new URL("../../../styles/sheets/impact.css", import.meta.url), "utf8");

  it("names every grid's columns, each with a fixed minimum (minmax(0, ...))", () => {
    expect(trackProblems(source)).toEqual([]);
  });

  it("finds the grids it guards (the check reads the real sheet)", () => {
    const grids = styleRules(source).filter((r) => r.decls.get("display") === "grid").flatMap((r) => r.selectors);
    expect(grids).toEqual(expect.arrayContaining([".rev-grid", ".about", ".area", ".foot-grid", ".biz", ".callbar", ".hero-grid"]));
  });

  it("sees an implicit column, an auto column, a bare fr and a content-sized minimum (RED proof)", () => {
    expect(trackProblems(".a{display:grid;gap:1rem}")).toEqual([".a: a grid with no column list"]);
    expect(trackProblems("@media (min-width:48rem){.b{display:grid;grid-template-columns:1.4fr 1fr}}")).toEqual([".b (@media (min-width:48rem)): 1.4fr, 1fr"]);
    expect(trackProblems(".c{display:grid;grid-template-columns:minmax(0,1fr) auto}")).toEqual([".c: auto"]);
    expect(trackProblems(".d{display:grid;grid-template-columns:repeat(2,minmax(min-content,1fr))}")).toEqual([".d: minmax(min-content,1fr)"]);
    expect(trackProblems('.e{display:grid;grid-template:"a b" auto/minmax(0,1fr) max-content}')).toEqual([".e: max-content"]);
    expect(trackProblems(".f{display:grid}@media (min-width:40rem){.f{grid-template-columns:minmax(0,1fr)}}")).toEqual([".f: a grid with no column list"]);
    // The allow-list names a track, not only a selector: the call bar may keep its one listed track, no other (review2 M1).
    expect(trackProblems(".callbar{display:grid;grid-template-columns:auto 1fr}")).toEqual([".callbar: auto, 1fr"]);
    expect(trackProblems(".callbar{display:grid;grid-template-columns:minmax(min-content,1fr) minmax(0,max-content)}")).toEqual([]);
  });

  it("allows fixed minimums, repeat() and auto-fit tracks with a fixed minimum", () => {
    expect(trackProblems(".a{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,max-content)}")).toEqual([]);
    expect(trackProblems(".b{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))}")).toEqual([]);
    expect(trackProblems(".c{display:grid;grid-template-columns:repeat(3,minmax(0,1fr)) 12rem 34%}")).toEqual([]);
  });
});
