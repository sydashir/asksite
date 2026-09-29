import { resolve } from "node:path";
import {
  API,
  DiagnosticCategory,
  TypeFlags,
  type Checker,
  type Diagnostic,
  type Program,
  type Project,
  type Snapshot,
  type Symbol as TsSymbol,
  type Type,
} from "typescript/unstable/sync";
import { SyntaxKind, type Expression, type Node, type SourceFile } from "typescript/unstable/ast";
import * as is from "typescript/unstable/ast/is";
import { BROWSER_FLOOR } from "../../src/browser-floor.ts";
import { compatAt, gapsAt, type Floor, type Gap } from "./bcd.ts";
import { indexLib, type LibIndex } from "./lib-index.ts";
import { apiName, describe, isPlainObjectMember, isSupportedConstant, keysFor } from "./mapping.ts";

// The browser floor check (P4-7): every runtime use of an API that a TypeScript default lib file
// declares is mapped to its MDN browser-compat-data entry and checked at the floor. Types only and
// feature tests (`typeof X`; the `y` of `typeof X.y` or `typeof X["y"]`, whose X is still read) are
// not uses. A use with no MDN key fails as unmapped. README.md maps each form it judges to its
// fixture.
//
// Known limits (README.md "Known limits"; our own client code, not an attacker boundary):
// - computed access (`globalThis[name]`, `Reflect.get`): judged only when the key's type is a string
//   literal; nothing else covers it;
// - `eval`, `Function`, string code in timers: not read; the owner app's planned CSP (Task 14,
//   `script-src 'self'`, no 'unsafe-eval') stops such code from running at all;
// - `any`-typed receivers: nothing covers them;
// - CSS and HTML features (and event names in strings or React props): not checked; Tailwind v4
//   targets Safari 16.4 and Vite lowers some CSS syntax for build.cssTarget, nothing checks the rest.
// Backstops: Playwright's WebKit and the user's iPhone run CURRENT WebKit, not iOS 16.4, so the
// browser tests (Task 16) and the iPhone check (Task 27) miss a too-new DOM API. Only the TypeScript
// lib gate (es2023, for ES built-ins) and this checker catch one.
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

const NOTHING = TypeFlags.Null | TypeFlags.Undefined | TypeFlags.Void;
// `// floor-ok: <reason>` to the end of a line, or `{/* floor-ok: <reason> */}` between JSX children
// (where a `//` line is text that the page shows).
const MARKER = /\/\/\s*floor-ok\b(.*)$|\{\s*\/\*\s*floor-ok\b(.*?)\*\/\s*\}/;
// Nothing but whitespace and comments: `/* ... */`, or `{/* ... */}` in JSX.
const ONLY_COMMENTS = /^\s*((\{\s*\/\*.*?\*\/\s*\}|\/\*.*?\*\/)\s*)*$/;

/**
 * TypeScript parses every heritage clause element and an instantiation expression (`Map<string, number>`)
 * as ExpressionWithTypeArguments, which it counts as a type node. A class's `extends` clause and an
 * instantiation expression still run; `implements` and an interface's `extends` are types.
 */
function runsAtRuntime(expressionWithTypeArguments: Node): boolean {
  const clause = expressionWithTypeArguments.parent;
  return !is.isHeritageClause(clause) || (clause.token === SyntaxKind.ExtendsKeyword && is.isClassLikeDeclaration(clause.parent));
}

function inTypePosition(node: Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (is.isExpressionWithTypeArguments(p)) return !runsAtRuntime(p);
    if (is.isTypeNode(p) || p.kind === SyntaxKind.TypeAliasDeclaration || p.kind === SyntaxKind.InterfaceDeclaration) return true;
    if (is.isStatement(p) || (is.isExpression(p) && p.kind !== SyntaxKind.Identifier)) return false;
  }
  return false;
}

function isFeatureTest(node: Node): boolean {
  let p = node.parent;
  while (p && is.isParenthesizedExpression(p)) p = p.parent;
  return p !== undefined && is.isTypeOfExpression(p);
}

/** Whether the global named here is constructed: `new X()`, `new ns.X()`, `new (X)()`, or `class extends X` (`super()` runs X). */
function constructs(node: Node): boolean {
  let n: Node = node;
  while ((is.isPropertyAccessExpression(n.parent) && n.parent.name === n) || is.isParenthesizedExpression(n.parent)) n = n.parent;
  const p = n.parent;
  if (is.isNewExpression(p)) return p.expression === n;
  return is.isExpressionWithTypeArguments(p) && p.expression === n && is.isHeritageClause(p.parent) && runsAtRuntime(p);
}

/** Whether an object literal is a destructuring assignment target: `({ x } = o)`, nested in one, or a for-of/for-in head. */
function isAssignmentPattern(literal: Node): boolean {
  for (let n: Node = literal, p = n.parent; p; n = p, p = p.parent) {
    if (is.isBinaryExpression(p)) return p.operatorToken.kind === SyntaxKind.EqualsToken && p.left === n;
    if (is.isForOfStatement(p) || is.isForInStatement(p)) return p.initializer === n;
    if (!(is.isPropertyAssignment(p) || is.isObjectLiteralExpression(p) || is.isArrayLiteralExpression(p) || is.isSpreadElement(p))) return false;
  }
  return false;
}

interface Lookup {
  node: Node;
  receiver: Expression | undefined;
  how: string;
}

interface Context {
  project: Project;
  checker: Checker;
  lib: LibIndex;
  floor: Floor;
  report: FloorReport;
}

function checkFile(ctx: Context, sf: SourceFile): void {
  const { project, checker, lib, floor, report } = ctx;
  // `floor-ok` markers by line; one alone on its line (only comments around it) also covers the next
  // line. One without a reason accepts nothing and is itself a failure.
  const markers = new Map<number, { reason: string | undefined; alone: boolean }>();
  sf.text.split("\n").forEach((text, index) => {
    const marker = MARKER.exec(text);
    if (!marker) return;
    const reason = /^:(.*)$/.exec(marker[1] ?? marker[2] ?? "")?.[1]?.trim() || undefined;
    const around = [text.slice(0, marker.index), text.slice(marker.index + marker[0].length)];
    markers.set(index + 1, { reason, alone: around.every((part) => ONLY_COMMENTS.test(part)) });
    if (!reason) {
      const finding: Finding = { file: sf.fileName, line: index + 1, column: marker.index + 1, api: "floor-ok", key: "floor-ok", kind: "bad-suppression", gaps: [] };
      report.findings.push(finding);
    }
  });
  const lookups: Lookup[] = [];
  const elements: Node[] = [];
  const bindings: Node[] = [];
  const shorthands: Node[] = [];
  const patterns: Node[] = [];
  const regexes: Node[] = [];
  const walk = (n: Node): void => {
    if (is.isPropertyAccessExpression(n) && is.isIdentifier(n.name)) {
      if (!isFeatureTest(n)) lookups.push({ node: n.name, receiver: n.expression, how: "property" });
    } else if (is.isElementAccessExpression(n)) {
      if (!isFeatureTest(n)) elements.push(n);
    } else if (is.isBindingElement(n) && is.isObjectBindingPattern(n.parent) && !n.dotDotDotToken) {
      bindings.push(n);
    } else if (is.isShorthandPropertyAssignment(n)) {
      shorthands.push(n);
    } else if (is.isObjectLiteralExpression(n) && isAssignmentPattern(n)) {
      patterns.push(n);
    } else if (is.isRegularExpressionLiteral(n)) {
      regexes.push(n);
    } else if (is.isIdentifier(n)) {
      // Not a declared name, a property name (handled above), a type or a JSX attribute name. The
      // receiver of `X.y` is a use of X: `Float16Array.from` and `typeof Float16Array.from` both read
      // the global first, whatever MDN says about the member.
      const p = n.parent as Node & { name?: Node; propertyName?: Node };
      const isName = p.name === n || p.propertyName === n;
      if (!isName && !inTypePosition(n) && !is.isJsxAttribute(p) && !isFeatureTest(n)) lookups.push({ node: n, receiver: undefined, how: "identifier" });
    }
    n.forEachChild(walk);
  };

  function record(node: Node, kind: FindingKind, api: string, key: string, gaps: Gap[]): void {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const finding: Finding = { file: sf.fileName, line: line + 1, column: character + 1, api, key, kind, gaps };
    const reason = suppression(line + 1);
    if (reason !== undefined) finding.suppressed = reason;
    report.findings.push(finding);
  }

  /** Records a finding when the key lacks full support at the floor; says whether it did. */
  function judge(node: Node, api: string, key: string): boolean {
    const compat = compatAt(key);
    const gaps = compat ? gapsAt(compat, floor) : [];
    if (gaps.length > 0) record(node, gaps.every((g) => g.partial) ? "partial" : "unsupported", api, key, gaps);
    return gaps.length > 0;
  }

  /** The `floor-ok` reason for a finding on this line: a marker on the line, or alone on the line before. */
  function suppression(line: number): string | undefined {
    const same = markers.get(line);
    if (same?.reason) return same.reason;
    const before = markers.get(line - 1);
    return before?.alone ? before.reason : undefined;
  }

  /**
   * The receiver's own types: unions and intersections split, null and undefined dropped, a type
   * parameter replaced by its constraint (for `this`, the class it belongs to).
   */
  function receiverTypes(type: Type | undefined, depth = 0): Type[] {
    if (!type || depth > 8 || type.flags & NOTHING) return [];
    if (type.isUnionType() || type.isIntersectionType()) return type.getTypes().flatMap((t) => receiverTypes(t, depth + 1));
    if (type.isTypeParameter()) return receiverTypes(checker.getConstraintOfTypeParameter(type) ?? checker.getBaseConstraintOfType(type), depth + 1);
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

  /** A destructured key's text: an identifier, a string literal, or a computed key of a string-literal type (as `URL[key]`). */
  function keyText(name: Node | undefined): string | undefined {
    if (name && (is.isIdentifier(name) || is.isStringLiteral(name))) return name.text;
    const type = name && is.isComputedPropertyName(name) ? checker.getTypeAtLocation(name.expression) : undefined;
    return type?.isStringLiteralType() ? String(type.value) : undefined;
  }

  /**
   * A property as `x?.y` reads it: on the type without null and undefined, so `div?.["showPopover"]`
   * on `HTMLDivElement | null`, a nullable constraint and a source a default covers all find it (a
   * union keeps its members together, as in the dot pass).
   */
  function propertyOf(type: Type | undefined, name: string): TsSymbol | undefined {
    const present = type && checker.getNonNullableType(type);
    return present && checker.getPropertyOfType(present, name);
  }

  /** The property's type on a source type; none when the source has no such property. */
  function typeOfProperty(source: Type, name: string): Type[] {
    const property = propertyOf(source, name);
    const type = property && checker.getTypeOfSymbol(property);
    return type ? [type] : [];
  }

  /** The element types of an array or tuple source (without null and undefined), at one index or (none given) at any; none for anything else. */
  function elementTypes(type: Type, index?: number): Type[] {
    const source = checker.getNonNullableType(type);
    if (!source?.isTypeReference()) return [];
    const args = checker.getTypeArguments(source);
    if (checker.isArrayType(source)) return args.slice(0, 1);
    if (!checker.isTupleType(source)) return [];
    return index === undefined ? [...args] : args.slice(index, index + 1);
  }

  /** Each type once, by its id: a source met twice (a tuple's elements, a default and what it covers) gives one finding. */
  function distinct(types: Type[]): Type[] {
    return [...new Map(types.map((t) => [t.id, t])).values()];
  }

  /**
   * The types a destructuring assignment pattern reads from: the right-hand side of its `=`, or the
   * elements of a for-of over an array or tuple; when nested, the outer pattern's property or element
   * (both, for a nested default). Empty when unknown (a for-of over any other iterable).
   */
  function patternSources(pattern: Node): Type[] {
    const p = pattern.parent;
    if (is.isForOfStatement(p) && p.initializer === pattern) {
      const iterable = checker.getTypeAtLocation(p.expression);
      return iterable ? elementTypes(iterable) : [];
    }
    if (is.isBinaryExpression(p) && p.left === pattern && p.operatorToken.kind === SyntaxKind.EqualsToken) {
      const own = checker.getTypeAtLocation(p.right);
      return [...(own ? [own] : []), ...patternSources(p)];
    }
    if (is.isPropertyAssignment(p) && p.initializer === pattern) {
      const name = keyText(p.name);
      return name === undefined ? [] : patternSources(p.parent).flatMap((source) => typeOfProperty(source, name));
    }
    if (is.isArrayLiteralExpression(p)) {
      const index = p.elements.findIndex((element) => element === pattern);
      return patternSources(p).flatMap((source) => elementTypes(source, index));
    }
    return [];
  }

  function evaluate(node: Node, how: string, symbol: TsSymbol | undefined, receiverType: () => Type | undefined): void {
    const handle = symbol?.valueDeclaration ?? symbol?.declarations[0];
    if (!symbol || !handle || !lib.isLibFile(handle.path)) return;
    const decl = handle.resolve(project);
    const d = decl && describe(decl);
    if (d?.kind === "member" && !symbol.valueDeclaration && how === "identifier") return; // e.g. object-literal keys
    report.sites++;
    if (!decl || !d) return record(node, "unmapped", symbol.name, symbol.name, []); // a lib declaration of an unknown shape
    // Each receiver type maps on its own: `Request | Response` checks both, `EventTarget & HTMLDivElement`
    // finds the member on HTMLDivElement.
    const chains = d.kind === "member" && !d.isStatic ? receiverTypes(receiverType()).map(typeChain) : [];
    const keys = keysFor(d, chains, lib);
    const passesUnmapped = isPlainObjectMember(d, lib) || isSupportedConstant(d, decl, floor);
    if (keys.length === 0 && !passesUnmapped) record(node, "unmapped", apiName(d), apiName(d), []);
    for (const key of keys) {
      // MDN files a constructor under its interface, and it can be newer (Iterator 10, its constructor
      // 18.4): a global that passes on its own entry is then judged on the constructor it runs.
      if (!judge(node, apiName(d), key) && d.kind === "global" && constructs(node)) judge(node, apiName(d), `${key}.${d.name}`);
    }
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
  lookups.forEach((l, i) => evaluate(l.node, l.how, symbols[i], () => (l.receiver ? checker.getTypeAtLocation(l.receiver) : undefined)));
  // URL["canParse"], URL[key] with a literal-typed key
  for (const n of elements) {
    if (!is.isElementAccessExpression(n)) continue;
    const keyType = checker.getTypeAtLocation(n.argumentExpression);
    if (!keyType?.isStringLiteralType()) continue;
    const receiverType = checker.getTypeAtLocation(n.expression);
    evaluate(n.argumentExpression, "element", propertyOf(receiverType, String(keyType.value)), () => receiverType);
  }
  // const { canParse } = URL, and every other binding pattern: TypeScript types the pattern from its source
  for (const b of bindings) {
    if (!is.isBindingElement(b)) continue;
    const nameNode = b.propertyName ?? b.name;
    const key = keyText(nameNode);
    if (!nameNode || key === undefined) continue;
    const patternType = checker.getTypeAtLocation(b.parent);
    evaluate(nameNode, "destructure", propertyOf(patternType, key), () => patternType);
  }
  // ({ canParse } = URL), ({ canParse: c } = URL), nested or with a default: TypeScript types this
  // literal from its targets, so each property is read from the source on the right-hand side. A
  // source is read without null and undefined (a default covers them), so an outer property or a
  // tuple element `X | undefined` and its default `X` are one source, not two.
  for (const pattern of patterns) {
    if (!is.isObjectLiteralExpression(pattern)) continue;
    const sources = distinct(patternSources(pattern).flatMap((t) => checker.getNonNullableType(t) ?? []));
    if (sources.length === 0) record(pattern, "unmapped", "destructuring assignment", "source not judged", []); // e.g. `for ({ x } of aSet)`
    for (const property of pattern.properties) {
      const name = is.isPropertyAssignment(property) || is.isShorthandPropertyAssignment(property) ? property.name : undefined;
      const key = keyText(name);
      if (!name || key === undefined) continue; // a spread reads the whole object
      for (const source of sources) evaluate(name, "destructure", propertyOf(source, key), () => source);
    }
  }
  // { requestIdleCallback }: its name is also the object's own property, so ask for the value it reads
  for (const s of shorthands) {
    if (is.isShorthandPropertyAssignment(s)) evaluate(s.name, "identifier", checker.getShorthandAssignmentValueSymbol(s), () => undefined);
  }
  for (const r of regexes) checkRegex(r);
}

/** A use whose type does not resolve is silently not a use, so only a clean program is judged. */
function assertTypeChecks(tsconfig: string, program: Program): void {
  const errors = [
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getProgramDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ].filter((d) => d.category === DiagnosticCategory.Error);
  if (errors.length === 0) return;
  const where = (d: Diagnostic): string => {
    const at = d.fileName ? program.getSourceFile(d.fileName)?.getLineAndCharacterOfPosition(d.pos) : undefined;
    return d.fileName ? `${d.fileName}${at ? `:${at.line + 1}:${at.character + 1}` : ""} ` : "";
  };
  const list = errors.map((d) => `  ${where(d)}TS${d.code}: ${d.text}`).join("\n");
  throw new Error(`${tsconfig} does not type-check, so the floor check cannot judge it:\n${list}`);
}

/**
 * The project of one tsconfig in a snapshot, selected by the config file's path: the API lists a
 * snapshot's projects in its own order (by path), not in the order they were opened.
 */
export function projectFor(snapshot: Snapshot, tsconfig: string): Project {
  const project = snapshot.getProject(resolve(tsconfig));
  if (!project) throw new Error(`No TypeScript project for ${tsconfig}`);
  return project;
}

/** Checks the program of one tsconfig at the floor (default: the owner client's, src/browser-floor.ts). */
export function checkFloor(tsconfig: string, floor: Floor = BROWSER_FLOOR): FloorReport {
  const api = new API({ cwd: process.cwd() });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [resolve(tsconfig)] });
    try {
      const project = projectFor(snapshot, tsconfig);
      const { program, checker } = project;
      assertTypeChecks(tsconfig, program);
      const files = program.getSourceFileNames().filter((f) => !f.endsWith(".d.ts") && !f.includes("/node_modules/"));
      const report: FloorReport = { floor, files: files.length, sites: 0, findings: [] };
      const lib = indexLib(program);
      for (const file of files) {
        const sf = program.getSourceFile(file);
        if (sf) checkFile({ project, checker, lib, floor, report }, sf);
      }
      return report;
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}
