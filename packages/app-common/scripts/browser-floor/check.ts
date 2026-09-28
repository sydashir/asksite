import { resolve } from "node:path";
import { API, TypeFlags, type Checker, type Project, type Symbol as TsSymbol, type Type } from "typescript/unstable/sync";
import { SyntaxKind, type Expression, type Node, type SourceFile } from "typescript/unstable/ast";
import * as is from "typescript/unstable/ast/is";
import { BROWSER_FLOOR } from "../../src/browser-floor.ts";
import { compatAt, gapsAt, hasEntry, type Floor, type Gap } from "./bcd.ts";

// The browser floor check (P4-7): every runtime use of an API that a TypeScript default lib file
// declares is mapped to its MDN browser-compat-data entry and checked at the floor. Types only and
// feature tests (`typeof X.y`) are not uses.
//
// TypeScript 7.0 ships no stable compiler API ("we won't have a stable programmatic API available
// until at least several months from now with TypeScript 7.1", 7.0 RC notes); `typescript/unstable/*`
// is what the 7.0.2 package exports. It is pinned exactly, and the fixture test guards every rule.

export type FindingKind = "unsupported" | "partial" | "unmapped" | "bad-suppression";

export interface Finding {
  file: string;
  line: number;
  column: number;
  /** What the code uses, e.g. `URL.canParse`. */
  api: string;
  /** The MDN key checked, or the lib name when no key was found. */
  key: string;
  kind: FindingKind;
  /** The floor browsers without support, with MDN's `version_added`. */
  gaps: Gap[];
  /** The `floor-ok` reason that accepts this finding. */
  suppressed?: string;
}

export interface FloorReport {
  floor: Floor;
  files: number;
  sites: number;
  findings: Finding[];
}

type Described =
  | { kind: "member"; owner: string; member: string; isStatic: boolean; ns: string }
  | { kind: "global"; name: string; ns: string };

const MEMBER_KINDS = new Set([
  SyntaxKind.MethodSignature,
  SyntaxKind.PropertySignature,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);
const GLOBAL_KINDS = new Set([
  SyntaxKind.VariableDeclaration,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.ModuleDeclaration,
]);
const TYPED_ARRAY = /^(Int8|Uint8|Uint8Clamped|Int16|Uint16|Int32|Uint32|Float16|Float32|Float64|BigInt64|BigUint64)Array$/;
const ITERATOR = /^(IteratorObject|Iterator|BuiltinIterator|IteratorHelper)$/;
const NOTHING = TypeFlags.Null | TypeFlags.Undefined | TypeFlags.Void;

/** The JavaScript builtin that MDN files a lib interface under. */
function jsOwner(owner: string): string {
  if (TYPED_ARRAY.test(owner)) return "TypedArray";
  if (ITERATOR.test(owner)) return "Iterator";
  return { ReadonlyArray: "Array", ReadonlySet: "Set", ReadonlyMap: "Map" }[owner] ?? owner;
}
const bcdName = (owner: string): string => (owner === "Console" ? "console" : owner);

function nameOf(node: Node | undefined): string | undefined {
  const name = (node as { name?: Node } | undefined)?.name;
  return name && (is.isIdentifier(name) || is.isStringLiteral(name)) ? name.text : undefined;
}

function describe(node: Node): Described | undefined {
  let ns = "";
  for (let p = node.parent; p; p = p.parent) {
    const name = is.isModuleDeclaration(p) ? nameOf(p) : undefined;
    if (name && name !== "global") ns = name + (ns ? "." + ns : "");
  }
  if (MEMBER_KINDS.has(node.kind)) {
    const container = node.parent;
    const member = nameOf(node);
    if (!member) return undefined;
    if (is.isTypeLiteralNode(container) && is.isVariableDeclaration(container.parent)) {
      const owner = nameOf(container.parent);
      return owner ? { kind: "member", owner, member, isStatic: true, ns } : undefined;
    }
    if (is.isInterfaceDeclaration(container) || is.isClassDeclaration(container)) {
      const name = nameOf(container);
      if (!name) return undefined;
      if (name.endsWith("Constructor")) return { kind: "member", owner: name.slice(0, -"Constructor".length), member, isStatic: true, ns };
      return { kind: "member", owner: name, member, isStatic: false, ns };
    }
    return undefined;
  }
  const name = GLOBAL_KINDS.has(node.kind) ? nameOf(node) : undefined;
  return name ? { kind: "global", name, ns } : undefined;
}

function candidateKeys(d: Described, receiverChain: string[]): string[] {
  if (d.kind === "global") {
    // WebIDL namespaces (CSS, console, WebAssembly) are `declare namespace` in lib.dom and `_static` in MDN.
    if (d.ns) return [`javascript.builtins.${d.ns}.${d.name}`, `api.${d.ns}.${d.name}_static`, `api.${d.ns}.${d.name}`];
    return [`api.${d.name}`, `api.Window.${d.name}`, `javascript.builtins.${d.name}`];
  }
  const { owner, member, isStatic, ns } = d;
  const keys = [ns ? `javascript.builtins.${ns}.${owner}.${member}` : `javascript.builtins.${jsOwner(owner)}.${member}`];
  if (isStatic) {
    keys.push(`api.${owner}.${member}_static`, `api.${owner}.${member}`); // MDN omits _static on a few
    return keys;
  }
  const owners = [...receiverChain, owner].map(bcdName);
  for (const o of owners) keys.push(`api.${o}.${member}`);
  for (const o of owners) keys.push(`api.${o}.${member}_static`); // namespace objects: console.log
  const event = /^on([a-z]+)$/.exec(member)?.[1]; // MDN files onX handler properties as X_event
  if (event) for (const o of owners) keys.push(`api.${o}.${event}_event`);
  return keys;
}

function inTypePosition(node: Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (
      is.isTypeNode(p) ||
      p.kind === SyntaxKind.TypeAliasDeclaration ||
      p.kind === SyntaxKind.InterfaceDeclaration ||
      (p.kind === SyntaxKind.HeritageClause && p.parent.kind === SyntaxKind.InterfaceDeclaration)
    )
      return true;
    if (is.isStatement(p) || (is.isExpression(p) && p.kind !== SyntaxKind.Identifier)) return false;
  }
  return false;
}

function isFeatureTest(node: Node): boolean {
  let p = node.parent;
  while (p && is.isParenthesizedExpression(p)) p = p.parent;
  return p !== undefined && is.isTypeOfExpression(p);
}

interface Lookup {
  node: Node;
  receiver: Expression | undefined;
  how: string;
}

interface Context {
  project: Project;
  checker: Checker;
  floor: Floor;
  report: FloorReport;
}

function checkFile(ctx: Context, sf: SourceFile): void {
  const { project, checker, floor, report } = ctx;
  const lines = sf.text.split("\n");
  const lookups: Lookup[] = [];
  const elements: Node[] = [];
  const bindings: Node[] = [];
  const regexes: Node[] = [];
  const walk = (n: Node): void => {
    if (is.isPropertyAccessExpression(n) && is.isIdentifier(n.name)) {
      if (!isFeatureTest(n)) lookups.push({ node: n.name, receiver: n.expression, how: "property" });
    } else if (is.isElementAccessExpression(n)) {
      elements.push(n);
    } else if (is.isBindingElement(n) && is.isObjectBindingPattern(n.parent) && !n.dotDotDotToken) {
      bindings.push(n);
    } else if (is.isRegularExpressionLiteral(n)) {
      regexes.push(n);
    } else if (is.isIdentifier(n)) {
      // Not a declared name, a property name (handled above), a type or a JSX attribute name.
      const p = n.parent as Node & { name?: Node; propertyName?: Node };
      const isName = p.name === n || p.propertyName === n;
      if (!isName && !is.isPropertyAccessExpression(p) && !inTypePosition(n) && !is.isJsxAttribute(p) && !isFeatureTest(n))
        lookups.push({ node: n, receiver: undefined, how: "identifier" });
    }
    n.forEachChild(walk);
  };

  function judge(node: Node, api: string, key: string): void {
    const compat = compatAt(key);
    if (!compat) return;
    const gaps = gapsAt(compat, floor);
    if (gaps.length === 0) return;
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const finding: Finding = { file: sf.fileName, line: line + 1, column: character + 1, api, key, kind: "unsupported", gaps };
    const reason = suppression(line + 1);
    if (reason !== undefined) finding.suppressed = reason;
    report.findings.push(finding);
  }

  function suppression(line: number): string | undefined {
    for (const text of [lines[line - 1], lines[line - 2]]) if (text && /floor-ok/.test(text)) return text.trim();
    return undefined;
  }

  /** The receiver's own types: unions and intersections split, null and undefined dropped. */
  function receiverTypes(type: Type | undefined, depth = 0): Type[] {
    if (!type || depth > 8 || type.flags & NOTHING) return [];
    if (type.isUnionType() || type.isIntersectionType()) return type.getTypes().flatMap((t) => receiverTypes(t, depth + 1));
    return [type];
  }

  /** A type's name, then the names of its base types. */
  function typeChain(type: Type): string[] {
    const out: string[] = [];
    const visit = (t: Type, depth: number): void => {
      if (depth > 8) return;
      const name = t.getSymbol()?.name;
      if (name && !out.includes(name)) out.push(name);
      if (t.isClassOrInterface()) for (const base of checker.getBaseTypes(t)) visit(base, depth + 1);
      else if (t.isTypeReference()) visit(t.getTarget(), depth + 1);
    };
    visit(type, 0);
    return out;
  }

  function evaluate(node: Node, how: string, symbol: TsSymbol | undefined, receiver: Expression | undefined): void {
    const handle = symbol?.valueDeclaration ?? symbol?.declarations[0];
    if (!symbol || !handle || !isLibPath(handle.path)) return;
    const decl = handle.resolve(project);
    const d = decl && describe(decl);
    if (!d) return;
    if (d.kind === "member" && !symbol.valueDeclaration && how === "identifier") return; // e.g. object-literal keys
    report.sites++;
    // Each receiver type maps on its own: `Request | Response` checks both, `EventTarget & HTMLDivElement`
    // finds the member on HTMLDivElement.
    const chains = d.kind === "member" && !d.isStatic && receiver ? receiverTypes(checker.getTypeAtLocation(receiver)).map(typeChain) : [];
    const keys = new Set<string>();
    for (const chain of chains.length ? chains : [[]]) {
      const key = candidateKeys(d, chain).find((k) => compatAt(k));
      if (key) keys.add(key);
    }
    const api = d.kind === "global" ? [d.ns, d.name].filter(Boolean).join(".") : `${d.owner}.${d.member}`;
    for (const key of keys) judge(node, api, key); // no key: not a feature (e.g. a dictionary member) or unmapped, not checked
  }

  function checkRegex(node: Node): void {
    if (!is.isRegularExpressionLiteral(node)) return;
    const src = node.text;
    const flags = src.slice(src.lastIndexOf("/") + 1);
    const body = src.slice(1, src.lastIndexOf("/"));
    const features: string[] = [];
    if (flags.includes("v")) features.push("javascript.builtins.RegExp.unicodeSets");
    if (flags.includes("d")) features.push("javascript.builtins.RegExp.hasIndices");
    if (/\(\?<[=!]/.test(body)) features.push("javascript.regular_expressions.lookbehind_assertion");
    if (/\(\?[imsx]*-?[imsx]+:/.test(body)) features.push("javascript.regular_expressions.modifier");
    for (const key of features) {
      report.sites++;
      judge(node, key, key);
    }
  }

  walk(sf);
  const symbols = lookups.length ? checker.getSymbolAtLocation(lookups.map((l) => l.node)) : [];
  lookups.forEach((l, i) => evaluate(l.node, l.how, symbols[i], l.receiver));
  // URL["canParse"], URL[key] with a literal-typed key
  for (const n of elements) {
    if (!is.isElementAccessExpression(n)) continue;
    const keyType = checker.getTypeAtLocation(n.argumentExpression);
    if (!keyType?.isStringLiteralType()) continue;
    const receiverType = checker.getTypeAtLocation(n.expression);
    const symbol = receiverType && checker.getPropertyOfType(receiverType, String(keyType.value));
    evaluate(n.argumentExpression, "element", symbol, n.expression);
  }
  // const { canParse } = URL
  for (const b of bindings) {
    if (!is.isBindingElement(b)) continue;
    const nameNode = b.propertyName ?? b.name;
    if (!nameNode || !is.isIdentifier(nameNode)) continue;
    const patternType = checker.getTypeAtLocation(b.parent);
    const symbol = patternType && checker.getPropertyOfType(patternType, nameNode.text);
    const initializer = is.isVariableDeclaration(b.parent.parent) ? b.parent.parent.initializer : undefined;
    evaluate(nameNode, "destructure", symbol, initializer);
  }
  for (const r of regexes) checkRegex(r);
}

function isLibPath(path: string): boolean {
  return /[\\/]lib\.[a-z0-9.]+\.d\.ts$/i.test(path) && /typescript/i.test(path);
}

/** Checks the program of one tsconfig at the floor (default: the owner client's, src/browser-floor.ts). */
export function checkFloor(tsconfig: string, floor: Floor = BROWSER_FLOOR): FloorReport {
  const api = new API({ cwd: process.cwd() });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [resolve(tsconfig)] });
    try {
      const project = snapshot.getProjects()[0];
      if (!project) throw new Error(`No TypeScript project for ${tsconfig}`);
      const { program, checker } = project;
      const files = program.getSourceFileNames().filter((f) => !f.endsWith(".d.ts") && !f.includes("/node_modules/"));
      const report: FloorReport = { floor, files: files.length, sites: 0, findings: [] };
      for (const file of files) {
        const sf = program.getSourceFile(file);
        if (sf) checkFile({ project, checker, floor, report }, sf);
      }
      return report;
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}
