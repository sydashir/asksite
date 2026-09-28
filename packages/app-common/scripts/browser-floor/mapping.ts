import { SyntaxKind, type Node } from "typescript/unstable/ast";
import * as is from "typescript/unstable/ast/is";
import { compatAt, hasEntry } from "./bcd.ts";
import type { LibIndex } from "./lib-index.ts";

// From a TypeScript lib declaration to the MDN browser-compat-data keys a use of it maps to.
// MDN's naming rules (docs/data-guidelines/api.md): static members end in `_static`; an `onX`
// handler is the `X_event` entry; mixin members sit under the interfaces that expose them; APIs on
// both Window and WorkerGlobalScope sit at the `api.` root (api/_globals).

export type Described =
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
/** Lib names that MDN files under another interface name. */
const MDN_INTERFACE: Record<string, string> = {
  Console: "console",
  // TypeScript's typed view of HTMLCollection (what getElementsByTagName returns in WebIDL).
  HTMLCollectionOf: "HTMLCollection",
};
/** The mixin whose members MDN files at the `api.` root (api/_globals). */
const GLOBAL_SCOPE_MIXIN = "WindowOrWorkerGlobalScope";

/** The JavaScript builtin that MDN files a lib interface under. */
export function jsOwner(owner: string): string {
  if (TYPED_ARRAY.test(owner)) return "TypedArray";
  if (ITERATOR.test(owner)) return "Iterator";
  return { ReadonlyArray: "Array", ReadonlySet: "Set", ReadonlyMap: "Map" }[owner] ?? owner;
}
const mdnInterface = (owner: string): string => MDN_INTERFACE[owner] ?? owner;
const eventOf = (handler: string): string | undefined => /^on([a-z]+)$/.exec(handler)?.[1];
/** The class's own entry first (Uint8Array.fromBase64), then the builtin MDN files the shared members under (TypedArray.from). */
const builtinKeys = (owner: string, member: string): string[] => [...new Set([owner, jsOwner(owner)])].map((o) => `javascript.builtins.${o}.${member}`);

function nameOf(node: Node | undefined): string | undefined {
  const name = (node as { name?: Node } | undefined)?.name;
  return name && (is.isIdentifier(name) || is.isStringLiteral(name)) ? name.text : undefined;
}

/** What a lib declaration is: a member of an interface (or of a global's type), or a global. */
export function describe(node: Node): Described | undefined {
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

/** How a finding names the API, e.g. `URL.canParse`. */
export function apiName(d: Described): string {
  return d.kind === "global" ? [d.ns, d.name].filter(Boolean).join(".") : `${d.owner}.${d.member}`;
}

/** Keys to try in order for one receiver type chain (the declaring owner is tried last). */
function candidateKeys(d: Described, chain: string[]): string[] {
  if (d.kind === "global") {
    // WebIDL namespaces (CSS, console, WebAssembly) are `declare namespace` in lib.dom and `_static` in MDN.
    if (d.ns) return [`javascript.builtins.${d.ns}.${d.name}`, `api.${d.ns}.${d.name}_static`, `api.${d.ns}.${d.name}`];
    const event = eventOf(d.name);
    return [`api.${d.name}`, `api.Window.${d.name}`, `javascript.builtins.${d.name}`, ...(event ? [`api.Window.${event}_event`] : [])];
  }
  const { owner, member, isStatic, ns } = d;
  const keys = ns ? [`javascript.builtins.${ns}.${owner}.${member}`] : builtinKeys(owner, member);
  if (isStatic) {
    keys.push(`api.${owner}.${member}_static`, `api.${owner}.${member}`); // MDN omits _static on a few
    return keys;
  }
  const owners = [...chain, owner].map(mdnInterface);
  for (const o of owners) keys.push(`api.${o}.${member}`);
  for (const o of owners) keys.push(`api.${o}.${member}_static`); // namespace objects: console.log
  if (owner === GLOBAL_SCOPE_MIXIN) keys.push(`api.${member}`);
  const event = eventOf(member);
  if (event) for (const o of owners) keys.push(`api.${o}.${event}_event`);
  return keys;
}

/**
 * The MDN keys a use maps to: the first key of each receiver type chain; when none has one, the
 * declaring interface's bases, then the interfaces that include it when it is a mixin.
 */
export function keysFor(d: Described, chains: string[][], lib: LibIndex): string[] {
  const found = new Set<string>();
  const add = (chain: string[]): void => {
    const key = candidateKeys(d, chain).find((k) => compatAt(k));
    if (key) found.add(key);
  };
  for (const chain of chains.length ? chains : [[]]) add(chain);
  if (found.size === 0 && d.kind === "member" && !d.isStatic) {
    add(lib.bases(d.owner));
    for (const includer of lib.includers(d.owner)) add([includer, ...lib.bases(includer)]);
  }
  return [...found];
}

/**
 * A member of a plain-object type (a WebIDL dictionary such as ReadableStreamReadResult, or a
 * TypeScript helper type): no MDN entry, not a mixin and no global of that name. Reading it is not a
 * browser feature. Anything else without a key is unmapped.
 */
export function isPlainObjectMember(d: Described, lib: LibIndex): boolean {
  if (d.kind !== "member") return false;
  if (d.member === "prototype") return true; // `Array.prototype` itself is not a feature
  if (d.isStatic) return false;
  const { owner, ns } = d;
  return (
    !lib.isValue(owner) &&
    lib.includers(owner).length === 0 &&
    !hasEntry(`api.${owner}`) &&
    !hasEntry(ns ? `javascript.builtins.${ns}.${owner}` : `javascript.builtins.${jsOwner(owner)}`)
  );
}
