import { isSafeUrl, type UrlScheme } from "@asksite/site-schema";
import { escapeAttr, escapeText } from "./escape.ts";

/** Markup that is already safe. Only `html` templates and `trusted()` literals create it. */
export class SafeHtml {
  readonly #markup: string;
  constructor(markup: string) {
    this.#markup = markup;
  }
  toString(): string {
    return this.#markup;
  }
}

/** A URL whose scheme has been checked. The only value `html` accepts in a URL attribute (href, src, action, …). */
export class SafeUrl {
  readonly #href: string;
  constructor(href: string) {
    this.#href = href;
  }
  toString(): string {
    return this.#href;
  }
}

export type Value = string | number | SafeHtml | SafeUrl | false | null | undefined | readonly Value[];

/** Wrap a string literal from our own source (icons, boolean attributes). Never pass user data. */
export function trusted(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

/** Validate an absolute URL; throws on anything else, so an unsafe URL can never be rendered. */
export function safeUrl(input: string, allowed?: readonly UrlScheme[]): SafeUrl {
  if (!isSafeUrl(input, allowed)) throw new Error(`Unsafe URL rejected: ${JSON.stringify(input)}`);
  return new SafeUrl(input);
}

/** In-page link to one of our own element ids, e.g. "#services". */
export function fragment(id: string): SafeUrl {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`Invalid fragment id: ${JSON.stringify(id)}`);
  return new SafeUrl(`#${id}`);
}

type Context = { inTag: boolean; inQuote: boolean; attr: string };

// The attribute name just before `="`, allowing spaces around "=" as HTML does.
const ATTRIBUTE_NAME = /([^\s"'<>\/=]+)\s*=\s*$/;

// Tracks whether the end of the markup written so far is inside a tag and inside a
// double-quoted attribute value. Our literals never contain ">" inside attribute values.
function advance(context: Context, literal: string): Context {
  let { inTag, inQuote, attr } = context;
  for (let i = 0; i < literal.length; i++) {
    const c = literal[i];
    if (!inTag) {
      if (c === "<") inTag = true;
    } else if (inQuote) {
      if (c === '"') inQuote = false;
    } else if (c === '"') {
      inQuote = true;
      attr = ATTRIBUTE_NAME.exec(literal.slice(0, i))?.[1]?.toLowerCase() ?? "";
    } else if (c === ">") {
      inTag = false;
    }
  }
  return { inTag, inQuote, attr };
}

// Attributes a browser fetches or navigates to: only a SafeUrl may be interpolated.
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster", "cite", "data", "ping", "background", "xlink:href"]);

// Attributes that run script, carry CSS, hold several URLs or hold a whole HTML document:
// no interpolation at all (a future srcset needs its own SafeSrcset type first).
const isNeverInterpolated = (attr: string) =>
  attr.startsWith("on") || attr === "style" || attr === "srcset" || attr === "imagesrcset" || attr === "srcdoc";

function interpolate(value: Value, context: Context): string {
  if (context.inQuote && isNeverInterpolated(context.attr)) {
    throw new Error(`The ${context.attr} attribute never takes an interpolated value`);
  }
  if (value === false || value === null || value === undefined) {
    if (context.inQuote && URL_ATTRIBUTES.has(context.attr)) throw new Error(`Missing URL for ${context.attr}`);
    return "";
  }
  if (!context.inTag) {
    if (value instanceof SafeHtml) return value.toString();
    if (Array.isArray(value)) return value.map((v: Value) => interpolate(v, context)).join("");
    return escapeText(String(value));
  }
  if (!context.inQuote) {
    // Between attributes only trusted literals (e.g. a boolean attribute) are allowed.
    if (value instanceof SafeHtml) return value.toString();
    throw new Error("Interpolation inside a tag must be a double-quoted attribute value");
  }
  if (URL_ATTRIBUTES.has(context.attr)) {
    if (!(value instanceof SafeUrl)) throw new Error(`The ${context.attr} attribute needs a SafeUrl`);
    return escapeAttr(value.toString());
  }
  if (value instanceof SafeHtml || Array.isArray(value)) throw new Error(`Markup is not allowed in the ${context.attr} attribute`);
  return escapeAttr(String(value));
}

/**
 * Tagged template that escapes every interpolation for where it lands:
 * text nodes -> escapeText, quoted attributes -> escapeAttr, URL attributes -> SafeUrl only,
 * event-handler/style/srcset/srcdoc attributes -> never.
 */
export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  let context: Context = advance({ inTag: false, inQuote: false, attr: "" }, strings[0] ?? "");
  let out = strings[0] ?? "";
  values.forEach((value, i) => {
    out += interpolate(value, context);
    const literal = strings[i + 1] ?? "";
    context = advance(context, literal);
    out += literal;
  });
  return new SafeHtml(out);
}
