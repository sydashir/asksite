import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Source guards (A12). A design writes markup only through html`` templates, which escape every value for
// where it lands: no `new SafeHtml(`, and trusted() only around a string literal from its own source.
// The renderer never imports @asksite/site-css: site-css is built from the renderer's sheets and
// devDepends on it, so callers pass DESIGN_CSS in (no import cycle).
// KNOWN LIMIT (A12-0 round-2 rulings): the guard reads names, so an aliased import (`trusted as t`,
// `SafeHtml as S`) is not seen. Backstop: the page-safety matrix (test/xss.test.ts) renders every fixture
// in every design, electrical-xss with payloads in all nine sections, and fails on any live markup.

const SRC = new URL("../src/", import.meta.url);

function sources(dir: URL): Array<[path: string, text: string]> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry): Array<[string, string]> => {
    const url = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, dir);
    if (entry.isDirectory()) return sources(url);
    return entry.name.endsWith(".ts") ? [[url.pathname.slice(SRC.pathname.length), readFileSync(url, "utf8")]] : [];
  });
}

/** What a file under src/designs must not do. */
function designSourceProblems(text: string): string[] {
  const problems: string[] = [];
  if (/\bnew\s+SafeHtml\s*\(/.test(text)) problems.push("new SafeHtml(");
  for (const match of text.matchAll(/\btrusted\s*\(\s*/g)) {
    const rest = text.slice((match.index ?? 0) + match[0].length);
    const literal = /^(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\$]|\\.|\$(?!\{))*`)\s*\)/;
    if (!literal.test(rest)) problems.push(`trusted(${rest.slice(0, 30)}`);
  }
  return problems;
}

const importsSiteCss = (text: string) => /["']@asksite\/site-css["']/.test(text);

describe("design sources", () => {
  const designs = sources(new URL("designs/", SRC));

  it("covers every design folder", () => {
    expect(designs.map(([path]) => path)).toEqual(expect.arrayContaining(["designs/index.ts", "designs/impact/index.ts", "designs/refined/index.ts", "designs/modern/index.ts"]));
  });

  it.each(designs)("%s writes markup only through html templates", (_, text) => {
    expect(designSourceProblems(text)).toEqual([]);
  });

  it("no renderer source imports @asksite/site-css, and the package does not depend on it", () => {
    expect(sources(SRC).filter(([, text]) => importsSiteCss(text)).map(([path]) => path)).toEqual([]);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, Record<string, string> | undefined>;
    expect([pkg["dependencies"], pkg["devDependencies"]].flatMap((deps) => Object.keys(deps ?? {}))).not.toContain("@asksite/site-css");
  });
});

describe("the source guards can fail (RED proof)", () => {
  it.each([
    ["return new SafeHtml(`<p>${name}</p>`);", ["new SafeHtml("]],
    ["trusted(ctx.doc.facts.businessName)", ["trusted(ctx.doc.facts.businessName)"]],
    ["trusted(`<p>${name}</p>`)", ["trusted(`<p>${name}</p>`)"]],
    ["trusted('<b>' + name)", ["trusted('<b>' + name)"]],
  ])("catch %s", (text, problems) => {
    expect(designSourceProblems(text)).toEqual(problems);
  });

  it("allow trusted() around a string literal", () => {
    expect(designSourceProblems('trusted("<br>"); trusted(\'<hr>\'); trusted(`<svg viewBox="0 0 24 24"></svg>`)')).toEqual([]);
  });

  it("catch an import of @asksite/site-css", () => {
    expect(importsSiteCss('import { DESIGN_CSS } from "@asksite/site-css";')).toBe(true);
    expect(importsSiteCss('import { render } from "./render.ts";')).toBe(false);
  });
});
