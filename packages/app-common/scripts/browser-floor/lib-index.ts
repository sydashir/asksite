import type { Program } from "typescript/unstable/sync";
import * as is from "typescript/unstable/ast/is";
import { hasEntry } from "./bcd.ts";
import { jsOwner } from "./mapping.ts";

/** What the program's TypeScript default lib files declare, read once per program. */
export interface LibIndex {
  /** Whether a declaration's file (by its canonical path) is a default lib file. */
  isLibFile(path: string): boolean;
  /** Every interface a lib interface extends, directly or not, nearest first. */
  bases(name: string): string[];
  /** For a mixin, the MDN interfaces that include it; empty for anything else. */
  includers(name: string): string[];
  /** Whether the lib declares a global value of this name. */
  isValue(name: string): boolean;
}

const hasMdnInterface = (name: string): boolean => hasEntry(`api.${name}`) || hasEntry(`javascript.builtins.${jsOwner(name)}`);

export function indexLib(program: Program): LibIndex {
  const libFiles = new Set<string>();
  const heritage = new Map<string, string[]>();
  const values = new Set<string>();
  for (const file of program.getSourceFileNames()) {
    const sf = program.getSourceFile(file);
    if (!sf || !program.isSourceFileDefaultLibrary(sf)) continue;
    libFiles.add(sf.path);
    for (const st of sf.statements) {
      if (is.isInterfaceDeclaration(st)) {
        const list = heritage.get(st.name.text) ?? [];
        for (const clause of st.heritageClauses ?? []) for (const t of clause.types) if (is.isIdentifier(t.expression)) list.push(t.expression.text);
        heritage.set(st.name.text, list);
      } else if (is.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) if (is.isIdentifier(d.name)) values.add(d.name.text);
      } else if ((is.isFunctionDeclaration(st) || is.isClassDeclaration(st) || is.isModuleDeclaration(st)) && st.name && is.isIdentifier(st.name)) {
        values.add(st.name.text);
      }
    }
  }

  const bases = (name: string): string[] => {
    const out: string[] = [];
    const queue = [...(heritage.get(name) ?? [])];
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (next === name || out.includes(next)) continue;
      out.push(next);
      queue.push(...(heritage.get(next) ?? []));
    }
    return out;
  };

  // A mixin has no MDN entry; the MDN interfaces whose heritage reaches it (through other mixins
  // only) include it, e.g. GlobalEventHandlers: Document, HTMLElement, MathMLElement, SVGElement, Window.
  const includers = new Map<string, string[]>();
  for (const name of heritage.keys()) {
    if (!hasEntry(`api.${name}`)) continue;
    const queue = [...(heritage.get(name) ?? [])];
    for (let mixin = queue.shift(); mixin !== undefined; mixin = queue.shift()) {
      if (hasMdnInterface(mixin)) continue;
      const list = includers.get(mixin) ?? [];
      if (list.includes(name)) continue;
      includers.set(mixin, [...list, name]);
      queue.push(...(heritage.get(mixin) ?? []));
    }
  }

  return {
    isLibFile: (path) => libFiles.has(path),
    bases,
    includers: (name) => includers.get(name) ?? [],
    isValue: (name) => values.has(name),
  };
}
