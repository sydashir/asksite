import { readFileSync } from "node:fs";

// Classes that intentionally produce no CSS rule of their own: `group` is only a marker for
// group-open:/group-hover: selectors on descendants.
export const MARKER_CLASSES: ReadonlySet<string> = new Set(["group"]);

export function loadCompiledCss(): string {
  return readFileSync(new URL("../../styles/site.css", import.meta.url), "utf8");
}

// Port of CSSOM CSS.escape() (https://drafts.csswg.org/cssom/#serialize-an-identifier),
// which is how Tailwind writes selectors such as .md\:px-6 or .w-1\/2.
export function cssEscape(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    const code = value.charCodeAt(i);
    const isDigit = code >= 0x30 && code <= 0x39;
    if (code === 0) out += "�";
    else if ((code >= 0x1 && code <= 0x1f) || code === 0x7f || (i === 0 && isDigit) || (i === 1 && isDigit && value.charCodeAt(0) === 0x2d))
      out += `\\${code.toString(16)} `;
    else if (i === 0 && value.length === 1 && code === 0x2d) out += `\\${ch}`;
    else if (code >= 0x80 || code === 0x2d || code === 0x5f || isDigit || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a))
      out += ch;
    else out += `\\${ch}`;
  }
  return out;
}

/** True when the sheet has a selector for exactly this class (not merely a longer class starting with it). */
export function hasClassSelector(css: string, className: string): boolean {
  const needle = `.${cssEscape(className)}`;
  for (let i = css.indexOf(needle); i !== -1; i = css.indexOf(needle, i + 1)) {
    const next = css.charAt(i + needle.length);
    if (next === "" || !/[A-Za-z0-9_\\-]/.test(next)) return true;
  }
  return false;
}

/** Every class used in `html` class="" attributes. Our templates never use single-quoted attributes. */
export function classesIn(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/\sclass="([^"]*)"/g)) {
    for (const name of (match[1] ?? "").split(/\s+/)) if (name) found.add(name.replaceAll("&amp;", "&").replaceAll("&#39;", "'"));
  }
  return [...found].sort();
}

/** Classes used in `html` that the compiled stylesheet does not define. */
export function missingClasses(html: string, css: string): string[] {
  return classesIn(html).filter((name) => !MARKER_CLASSES.has(name) && !hasClassSelector(css, name));
}
