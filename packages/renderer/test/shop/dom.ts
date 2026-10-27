// Reads shop markup the way a browser does (parse5 follows the HTML standard), for structural checks.
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
export type Element = DefaultTreeAdapterMap["element"];

const isElement = (node: Node): node is Element => "tagName" in node;
const childrenOf = (node: Node): readonly Node[] => ("childNodes" in node ? node.childNodes : []);
// <template> content is not in childNodes; the shop never writes one.

/** Every element of the markup, in document order. */
export function elements(markup: string): Element[] {
  const out: Element[] = [];
  const walk = (node: Node): void => {
    if (isElement(node)) out.push(node);
    for (const child of childrenOf(node)) walk(child);
  };
  walk(parseFragment(markup));
  return out;
}

/** The value of an attribute, or undefined. */
export const attr = (el: Element, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value;

/** True when the element carries the class. */
export const hasClass = (el: Element, name: string): boolean => (attr(el, "class") ?? "").split(/\s+/).includes(name);

/** The element's text, decoded, with every descendant's text. */
export function textOf(node: Node): string {
  if ("value" in node && node.nodeName === "#text") return node.value;
  return childrenOf(node).map(textOf).join("");
}

/** The text of the whole markup, decoded. */
export const textIn = (markup: string): string => textOf(parseFragment(markup));

/** Elements matching a tag name and optional class. */
export const find = (markup: string, tag: string, cls?: string): Element[] => elements(markup).filter((el) => el.tagName === tag && (cls === undefined || hasClass(el, cls)));

/** What would run script, carry CSS or navigate to script: every element and attribute that should never appear. */
export function liveMarkup(markup: string): string[] {
  const problems: string[] = [];
  for (const el of elements(markup)) {
    if (["script", "style", "iframe", "object", "embed", "svg", "math", "template", "base", "meta", "link"].includes(el.tagName)) problems.push(`<${el.tagName}>`);
    for (const a of el.attrs) {
      if (a.name.startsWith("on")) problems.push(`${el.tagName}[${a.name}]`);
      if (["style", "srcdoc", "formaction"].includes(a.name)) problems.push(`${el.tagName}[${a.name}]`);
      if (["href", "src", "action"].includes(a.name) && /^\s*(?:javascript|data|vbscript):/i.test(a.value)) problems.push(`${el.tagName}[${a.name}=${a.value}]`);
    }
  }
  return problems;
}
